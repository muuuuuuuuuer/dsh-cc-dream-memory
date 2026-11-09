/**
 * Model-facing memory tools (v11: four tools only).
 *
 * The memory directory lives outside the workspace, so these tools are the
 * reliable cross-sandbox read/write path. The model gets exactly four tools:
 * `memory_save`, `memory_update`, `memory_read`, `memory_search` — their
 * descriptions + parameter schemas stay inside the 3000-character budget so
 * they never crowd the context.
 *
 * Human surfaces keep the full feature set: the `/memory` slash commands, the
 * Web UI and the HTTP API still expose status, dream, list, refresh, delete,
 * recall, pending writes, import/export and so on. This module intentionally
 * does NOT register those as tools any more.
 *
 * Every tool validates its arguments, resolves the calling agent's project
 * through `MemoryRuntime`, returns a plain JSON value (never throws to the
 * host) and — after a write — invalidates the prompt cache so the next request
 * sees the new index.
 *
 * Tool definitions follow the Host `ToolDefinition` contract:
 * `{ name, description, parameters, output: { schema, render }, execute }`,
 * where `render(args, value)` returns model-visible content blocks.
 *
 * @module dsh-cc-dream-memory/tools
 */
import { recordAdoption, recordRead, recordSearch, recordWrite } from './metrics.js';
import { queuePendingWrite } from './pending-writes.js';
import { evaluateWrite, textSimilarity } from './policy.js';
import { subagentWriteBlocked } from './status.js';
import { reviewWrite, memoryHash } from './write-review.js';

/** Permissive output schema: every result is a JSON object. */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
    error: { type: 'string', description: 'Stable error code when ok is false.' },
  },
  required: ['ok'],
  additionalProperties: true,
});

/** Scope selector shared by the write/read/search tools. */
const SCOPE_SCHEMA = Object.freeze({
  type: 'string',
  enum: ['project', 'user'],
  description: '"project" (default) or "user".',
});

/** Maximum number of existing entries compared by the write policy. */
const POLICY_ENTRY_LIMIT = 100;
/** Maximum number of candidate bodies read for the write policy (v12: the
 * name/description probe ranks entries first, so a save never reads 100 files). */
const POLICY_BODY_CANDIDATES = 12;
/** Body characters kept per entry for policy similarity. */
const POLICY_BODY_LIMIT = 4000;

/** Short caution appended to every memory tool description (v11: the full
 * wording lives in the injected rules; tool descriptions stay inside budget). */
const CONFIDENCE_SCHEMA = { type: 'string', enum: ['high', 'low'], description: 'Use low for unconfirmed inference; queues review.' };

const MEMORY_CAUTION = ' Verify before relying: memory may be stale.';

/** Whether memory writes are enabled (absent fields keep the feature on). */
function autoMemoryOn(config) {
  return !(config && (config.enabled === false || config.autoMemoryEnabled === false));
}

/** Structured result for a write tool while memory is turned off. */
function autoMemoryDisabled(config) {
  if (config && config.enabled === false) {
    return {
      ok: false,
      error: 'plugin-disabled',
      message: 'the memory plugin is disabled; run /memory plugin on',
    };
  }
  return {
    ok: false,
    error: 'auto-memory-disabled',
    message: 'auto memory is off; run /memory on',
  };
}

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/** Normalize the model-supplied arguments object. */
function argsOf(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/** Turn any thrown value into a structured tool result. */
function toolError(error) {
  const rawCode = typeof error?.code === 'string' && error.code !== '' ? error.code : 'INTERNAL';
  const result = {
    ok: false,
    error: rawCode,
    message: String(error?.message ?? error ?? rawCode),
  };
  if (Array.isArray(error?.warnings)) result.warnings = error.warnings;
  if (Array.isArray(error?.matches)) result.matchers = error.matches.map((match) => match.rule);
  return result;
}

/**
 * Provenance for one tool write: the calling session plus `tool:<name>`.
 * Falls back to the agent id when the execution carries no session id.
 * @param {object} exec tool execution context
 * @param {string} name tool name
 * @returns {{sessionId:string, via:string}}
 */
function sourceOf(exec, name) {
  const raw = typeof exec?.sessionId === 'string' && exec.sessionId !== '' ? exec.sessionId : exec?.agent?.id;
  return {
    sessionId: typeof raw === 'string' ? raw : '',
    via: `tool:${name}`,
  };
}

/** Notes older than this come with a reminder to check them. */
const STALE_AFTER_DAYS = 30;

/** How old a note is, so a reader can weigh it. */
function ageOf(entry) {
  const modified = Date.parse(entry?.frontmatter?.modified ?? entry?.modified ?? '');
  if (!Number.isFinite(modified)) return {};
  const ageDays = Math.max(0, Math.floor((Date.now() - modified) / (24 * 60 * 60 * 1000)));
  return ageDays >= STALE_AFTER_DAYS
    ? { ageDays, staleness: `Last updated ${ageDays} days ago; check it against the current code before relying on it.` }
    : { ageDays };
}

/** Session id for one tool execution (falls back to the agent id). */
function sessionIdOf(exec) {
  if (typeof exec?.sessionId === 'string' && exec.sessionId !== '') return exec.sessionId;
  return typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
}

/**
 * Existing entries enriched with bodies for the write policy.
 *
 * v12: the metadata (`listEntries`, no bodies) is ranked against the candidate's
 * name/description first and only the best {@link POLICY_BODY_CANDIDATES} get
 * their body read, so a save against a large memory directory stays cheap.
 * @param {object} store MemoryStore
 * @param {'project'|'user'} scope
 * @param {string} [excludeFile] file to skip (memory_update's own target)
 * @param {object} [candidate] candidate text used to rank body reads
 * @returns {Promise<object[]>}
 */
async function loadPolicyEntries(store, scope, excludeFile = '', candidate = null) {
  const entries = (await store.listEntries(scope)).filter((entry) => entry.file !== excludeFile);
  let ranked = entries;
  if (candidate && typeof candidate === 'object') {
    const probe = `${candidate.name ?? ''}\n${candidate.description ?? ''}`;
    ranked = entries
      .map((entry) => ({
        entry,
        score: textSimilarity(probe, `${entry.name}\n${entry.description}`),
      }))
      .sort((left, right) => right.score - left.score || left.entry.file.localeCompare(right.entry.file))
      .map((item) => item.entry);
  }
  const result = [];
  for (const entry of ranked.slice(0, POLICY_BODY_CANDIDATES)) {
    let body = '';
    try {
      const read = await store.readEntry(entry.file, scope);
      body = typeof read.body === 'string' ? read.body : '';
    } catch {
      body = '';
    }
    result.push({
      file: entry.file,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      body: body.slice(0, POLICY_BODY_LIMIT),
    });
  }
  return result;
}

/** Candidate shape for one policy evaluation. */
function policyCandidate({ scope, name, type, description, content, confidence }) {
  return {
    scope: scope === 'user' ? 'user' : 'project',
    name: typeof name === 'string' ? name : '',
    type: typeof type === 'string' ? type : '',
    description: typeof description === 'string' ? description : '',
    content: typeof content === 'string' ? content : '',
    confidence: confidence === 'low' ? 'low' : 'high',
  };
}

/**
 * v11 advisory fields for a write that proceeds anyway: near-duplicate
 * candidates and same-topic contradictory files are reported to the model so it
 * can update the existing file next time, but they never block the write.
 * @param {object|null} decision `evaluateWrite()` result
 * @returns {{conflicts?:object[], candidates?:object[], advisory?:boolean, hint?:string}}
 */
function advisoryOf(decision) {
  if (!decision || typeof decision !== 'object' || decision.advisory !== true) return {};
  const conflicts = Array.isArray(decision.conflicts) ? decision.conflicts : [];
  const candidates = Array.isArray(decision.candidates) ? decision.candidates : [];
  const result = { advisory: true };
  if (conflicts.length > 0) {
    result.conflicts = conflicts;
    result.hint = `Written, but it may contradict ${conflicts[0].file}. Review that memory and use memory_update to fix or extend it instead of keeping both.`;
  }
  if (candidates.length > 0) {
    result.candidates = candidates;
    if (!result.hint) {
      result.hint = `Written. Similar memories exist (${candidates[0].file}); prefer memory_update next time instead of creating near-duplicates.`;
    }
  }
  return result;
}

/** Render a JSON tool value as one text content block. */
function renderValue(_args, value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return [{ type: 'text', text: text ?? 'null' }];
}

/** Resolve the calling agent's project context, or a structured error. */
async function projectFor(runtime, exec) {
  const agent = exec?.agent;
  if (!agent || typeof agent.id !== 'string' || agent.id === '') {
    return { error: { ok: false, error: 'no-agent', message: 'memory tools require a live agent context' } };
  }
  let projectContext;
  try {
    projectContext = await runtime.forAgent(agent);
  } catch (error) {
    return { error: toolError(error) };
  }
  if (!projectContext || !projectContext.store || !projectContext.paths) {
    return {
      error: {
        ok: false,
        error: 'no-project',
        message: "could not resolve this project's memory directory",
      },
    };
  }
  return { agent, projectContext };
}

/** Notify the prompt cache owner after a memory write. */
function invalidate(runtime, agent) {
  try {
    runtime.invalidateInjection(agent.id);
  } catch (error) {
    warn('invalidateInjection', error);
  }
}

/** v10: read-only subagent result when `subagentWriteMode:'off'`. */
function subagentReadonly(config, exec) {
  return subagentWriteBlocked(exec?.agent, config)
    ? {
        ok: false,
        error: 'subagent-readonly',
        message: 'this subagent session is read-only (subagentWriteMode: off)',
      }
    : null;
}

/**
 * Register the four model-facing `memory_*` tools on the plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} runtime `MemoryRuntime` from `src/runtime.js`.
 * @returns {() => void} disposer removing every tool registration.
 */
export function registerTools(ctx, runtime) {
  // Dynamic view over `runtime.config` (a getter): Web/CLI toggles apply
  // immediately without re-registering the tools.
  const config = new Proxy({}, {
    get(_target, key) {
      const current = runtime?.config ?? {};
      return typeof key === 'string' ? current[key] : undefined;
    },
    has(_target, key) {
      const current = runtime?.config ?? {};
      return typeof key === 'string' && key in current;
    },
    ownKeys() {
      return Object.keys(runtime?.config ?? {});
    },
    getOwnPropertyDescriptor(_target, key) {
      const current = runtime?.config ?? {};
      if (typeof key !== 'string' || !(key in current)) return undefined;
      return { configurable: true, enumerable: true, value: current[key] };
    },
  });
  let tools;
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
  } catch (error) {
    warn('tools service', error);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn('tools service', new Error('ctx.tools is unavailable; memory tools are not registered'));
    return () => {};
  }

  /** @type {Array<() => void>} */
  const disposers = [];
  const register = (definition) => {
    const full = { ...definition, description: `${definition.description}${MEMORY_CAUTION}` };
    try {
      const dispose = tools.register(full);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(`register ${definition.name}`, error);
    }
  };

  // ------------------------------------------------------------------ save --
  register({
    name: 'memory_save',
    description:
      'Save a durable preference, correction or decision as file + index. Skip secrets and repo facts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short stable name, no file extension.' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'user, feedback, project or reference.',
        },
        description: { type: 'string', description: 'One-line index summary.' },
        content: { type: 'string', description: 'Markdown details.' },
        confidence: CONFIDENCE_SCHEMA,
        force: { type: 'boolean', description: 'Allow an intentional duplicate.' },
        scope: SCOPE_SCHEMA,
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(config, exec);
      if (blocked) return blocked;
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'name must be a non-empty string' };
      }
      if (typeof input.content !== 'string') {
        return { ok: false, error: 'INVALID_ARGUMENT', message: 'content must be a string' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      const projectContext = resolved.projectContext;
      const scope = input.scope === 'user' ? 'user' : 'project';
      const candidate = policyCandidate({
        scope,
        name: input.name,
        type: input.type ?? 'user',
        description: input.description,
        content: input.content,
        confidence: input.confidence,
      });
      try {
        const entries = await loadPolicyEntries(projectContext.store, scope, '', candidate);
        const stopped = await reviewWrite({ paths: projectContext.paths, candidate, entries,
          force: input.force === true, config, source: sourceOf(exec, 'memory_save') });
        if (stopped) { invalidate(runtime, resolved.agent); return stopped; }
        const advisory = input.force === true ? {} : advisoryOf(evaluateWrite({ candidate, entries, config }));
        const result = await projectContext.store.saveEntry({
          scope,
          name: input.name,
          type: input.type,
          description: input.description,
          content: input.content,
          source: sourceOf(exec, 'memory_save'),
        });
        invalidate(runtime, resolved.agent);
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
        }
        return { ...result, written: true, ...advisory };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  // ---------------------------------------------------------------- update --
  register({
    name: 'memory_update',
    description:
      'Update body, description or name; delete is recoverable.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Memory file name, e.g. user_role.md.' },
        name: { type: 'string', description: 'New stable name; renames file/index.' },
        content: { type: 'string', description: 'New Markdown body; omit to keep it.' },
        description: { type: 'string', description: 'New index summary; omit to keep it.' },
        delete: { type: 'boolean', description: 'Remove this memory.' },
        confidence: CONFIDENCE_SCHEMA,
        force: { type: 'boolean', description: 'Allow an intentional duplicate.' },
        scope: SCOPE_SCHEMA,
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(config, exec);
      if (blocked) return blocked;
      if (typeof input.file !== 'string' || input.file.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'file must be a memory file name' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      const projectContext = resolved.projectContext;
      const scope = input.scope === 'user' ? 'user' : 'project';
      try {
        let existing = null;
        try {
          existing = await projectContext.store.readEntry(input.file, scope);
        } catch {
          existing = null;
        }
        if (!existing) return { ok: false, error: 'NOT_FOUND', message: `memory file not found: ${input.file}` };
        if (input.delete === true) {
          if (config.writeMode === 'confirm' || input.confidence === 'low') {
            const queued = await queuePendingWrite(projectContext.paths, {
              action: 'delete',
              file: input.file,
              expectedHash: memoryHash(existing.raw),
              candidate: policyCandidate({
                scope,
                name: existing.frontmatter?.name,
                type: existing.frontmatter?.type,
                description: existing.frontmatter?.description,
                content: existing.body,
              }),
              reasons: [config.writeMode === 'confirm' ? 'writeMode is confirm: every write needs review' : 'confidence is low'],
              source: sourceOf(exec, 'memory_update'),
            });
            invalidate(runtime, resolved.agent);
            return {
              ok: true,
              written: false,
              action: 'queued-review',
              pendingId: queued.id,
              reasons: [config.writeMode === 'confirm' ? 'writeMode is confirm: every write needs review' : 'confidence is low'],
              hint: 'Queued for human review. Review with /memory writes; approve with /memory approve <id>.',
            };
          }
          await projectContext.store.trashEntry(input.file, { scope, reason: 'memory_update delete', expectedHash: memoryHash(existing.raw) });
          invalidate(runtime, resolved.agent);
          return { ok: true, deleted: true, file: input.file };
        }
        const candidate = policyCandidate({
          scope,
          name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name : existing?.frontmatter?.name,
          type: existing?.frontmatter?.type,
          description:
            input.description === undefined ? existing?.frontmatter?.description : input.description,
          content: input.content === undefined ? existing?.body : input.content,
          confidence: input.confidence,
        });
        const renameTo =
          typeof input.name === 'string' && input.name.trim() !== '' && input.name !== existing?.frontmatter?.name
            ? input.name
            : '';
        const entries = await loadPolicyEntries(projectContext.store, scope, existing.file, candidate);
        const stopped = await reviewWrite({ paths: projectContext.paths, action: 'update', file: input.file,
          name: renameTo, content: typeof input.content === 'string' ? input.content : null,
          description: typeof input.description === 'string' ? input.description : null,
          candidate, entries, existing, config, force: input.force === true, source: sourceOf(exec, 'memory_update') });
        if (stopped) { invalidate(runtime, resolved.agent); return stopped; }
        const advisory = input.force === true ? {} : advisoryOf(evaluateWrite({ candidate, entries, config }));
        let result;
        let renameResult = null;
        const wantsRename =
          typeof input.name === 'string' &&
          input.name.trim() !== '' &&
          input.name !== existing?.frontmatter?.name &&
          typeof projectContext.store.renameEntry === 'function';
        if (wantsRename) {
          // Rename + body/description are one store operation: validation runs
          // before any file is touched, so a rejected update cannot leave a
          // renamed file with stale content.
          renameResult = await projectContext.store.renameEntry(input.file, input.name, {
            scope,
            source: sourceOf(exec, 'memory_update'),
            expectedHash: memoryHash(existing.raw),
            content: input.content,
            description: input.description,
          });
          result = renameResult;
        } else {
          result = await projectContext.store.updateEntry(input.file, {
            scope,
            content: input.content,
            description: input.description,
            source: sourceOf(exec, 'memory_update'),
            expectedHash: memoryHash(existing.raw),
          });
        }
        invalidate(runtime, resolved.agent);
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
        }
        return { ...(renameResult ?? {}), ...result, ...advisory };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  // ------------------------------------------------------- eval-only dream --
  // Registers only for the offline evaluation profile (config.evalMode). It is
  // NOT part of the four model-facing tools and is absent in normal profiles.
  if (runtime?.config?.evalMode === true) {
    register({
      name: 'memory_eval_dream',
      description:
        'Evaluation harness only: run one Dream consolidation pass now (force, manual). Returns the run summary.',
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Only produce the plan; do not apply.' },
          sessions: { type: 'boolean', description: 'Read recent session transcripts (default false = pure consolidation).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const input = argsOf(args);
        const agent = exec?.agent;
        const projectContext = agent ? await runtime.forAgent(agent) : undefined;
        if (!projectContext) return { ok: false, error: 'no-project' };
        try {
          const result = await runtime.dream({
            agent,
            pctx: projectContext,
            force: true,
            dryRun: input?.dryRun === true,
            trigger: 'manual',
            reason: 'eval',
            // C group defaults to pure consolidation; transcript scenarios opt in
            // so the gather/watermark path is evaluated too.
            noSessions: input?.sessions !== true,
          });
          // Keep the result JSON-lossless and small: the tool layer rejects
          // nested plans/signals it cannot serialize losslessly.
          return {
            ok: true,
            ran: result?.ran === true,
            applied: result?.applied === true,
            skipped: result?.skipped === true,
            skipReason: typeof result?.skipReason === 'string' ? result.skipReason : '',
            ops: Number(result?.ops ?? result?.operations?.length ?? 0) || 0,
            filesTouched: Number(result?.filesTouched ?? 0) || 0,
            summary: typeof result?.summary === 'string' ? result.summary : '',
            path: typeof result?.path === 'string' ? result.path : '',
            dryRun: result?.dryRun === true,
            sessionsReviewed: Number(result?.sessionsReviewed ?? 0) || 0,
          };
        } catch (error) {
          return { ok: false, error: String(error?.code ?? 'dream-failed'), message: String(error?.message ?? error) };
        }
      },
    });
  }

  // ------------------------------------------------------------------ read --
  register({
    name: 'memory_read',
    description:
      'Read one memory file in full. Use when the index or a search snippet points at details you need.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Memory file name, e.g. user_role.md.' },
        scope: SCOPE_SCHEMA,
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (typeof input.file !== 'string' || input.file.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'file must be a memory file name' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      try {
        const entry = await resolved.projectContext.store.readEntry(input.file, input.scope);
        // v12: metrics are an effect, never a failure path for the read itself.
        // Both counters share one best-effort block.
        try {
          await recordRead(resolved.projectContext.paths, entry.file);
          await recordAdoption(resolved.projectContext.paths, entry.file, sessionIdOf(exec));
        } catch (error) {
          warn('read metrics', error);
        }
        return { ok: true, ...entry, ...ageOf(entry) };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  // ---------------------------------------------------------------- search --
  register({
    name: 'memory_search',
    description:
      'Search memory: ranked hits with snippets. Check before saving; read the full body with memory_read.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or phrase; space-separated words match independently.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum hits (default 20).' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Only this type.',
        },
        scope: SCOPE_SCHEMA,
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        return { ok: false, error: 'INVALID_ARGUMENT', message: 'query must be a non-empty string' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      try {
        const hits = await resolved.projectContext.store.search(input.query, {
          scope: input.scope,
          limit: input.limit,
          type: input.type,
        });
        await recordSearch(resolved.projectContext.paths, hits.length);
        const items = hits.map((hit) => ({
          file: hit.file,
          name: hit.name,
          description: hit.description,
          type: hit.type,
          score: hit.score,
          via: hit.via ?? '',
          snippets: Array.isArray(hit.snippets) ? hit.snippets : [hit.snippet].filter(Boolean),
        }));
        return {
          ok: true,
          query: input.query,
          count: items.length,
          items,
          hint: 'Read a file with memory_read when you need its full body; prefer memory_update for something already covered.',
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return function dispose() {
    for (const disposeTool of disposers.splice(0)) {
      try {
        disposeTool();
      } catch (error) {
        warn('dispose tool', error);
      }
    }
  };
}
