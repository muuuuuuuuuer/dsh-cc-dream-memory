/**
 * Model-facing memory tools (v11: four tools only).
 *
 * The memory directory lives outside the workspace, so these tools are the
 * reliable cross-sandbox read/write path. The model gets exactly four tools:
 * `memory_save`, `memory_update`, `memory_read`, `memory_search` 鈥?their
 * descriptions + parameter schemas stay inside the 3000-character budget so
 * they never crowd the context.
 *
 * Human surfaces keep the full feature set: the `/memory` slash commands, the
 * Web UI and the HTTP API still expose status, dream, list, refresh, delete,
 * recall, import/export and so on. This module intentionally
 * does NOT register those as tools any more.
 *
 * Every tool validates its arguments, resolves the calling agent's project
 * through `MemoryRuntime`, returns a plain JSON value (never throws to the
 * host) and 鈥?after a write 鈥?invalidates the prompt cache so the next request
 * sees the new index.
 *
 * Tool definitions follow the Host `ToolDefinition` contract:
 * `{ name, description, parameters, output: { schema, render }, execute }`,
 * where `render(args, value)` returns model-visible content blocks.
 *
 * @module dsh-cc-dream-memory/tools
 */
import { currentBody, memoryStatusOf, statusHidingMessage, statusHidingPage } from './memory-body.js';
import { recordRead, recordSearch, recordWrite } from './metrics.js';
import { evaluateWrite, textSimilarity } from './policy.js';
import { WIKI_READONLY_MESSAGE, WIKI_TYPE, normalizeType } from './store.js';
import { brokenNote, checkSources, normalizeSources } from './sources.js';
import { isDelegated } from './session-kind.js';
import { checkSessionCitations } from './citation.js';
import { recordVerifiedEntry, verifiedPage } from './verification-ledger.js';
import { composeCorrection, ensureCurrentStatus, memoryHash, replacePassage, splitMemoryBody } from './write-review.js';

/**
 * Record that a page cites words the user wrote.
 *
 * The ledger feeds the trust badge in the Memory panel and nothing else. A
 * failed ledger write must not undo a successful memory write, so it degrades
 * to a warning.
 * @param {{store:object, scope?:string, file:string,
 *   entry:{name?:string, description?:string, bodyHash?:string}}} input
 * @returns {Promise<'recorded'|'pending'>}
 */
async function recordExplicitVerification({ store, scope, file, entry }) {
  if (typeof file !== 'string' || file === '') return 'pending';
  if (!entry || typeof entry.bodyHash !== 'string' || entry.bodyHash === '') return 'pending';
  try {
    const record = await recordVerifiedEntry({
      store,
      scope,
      file,
      name: entry.name ?? '',
      description: entry.description ?? '',
      bodyHash: entry.bodyHash,
      source: 'user-citation',
    });
    return record ? 'recorded' : 'pending';
  } catch (error) {
    warn('record verification', error);
    return 'pending';
  }
}

/**
 * True when the ledger already recorded this page as it is on disk. A cited
 * summary edit that leaves the body alone can keep that record.
 */
async function wasVerified(store, scope, existing) {
  try {
    const meta = (await store.listEntries(scope)).find((entry) => entry.file === existing?.file);
    return Boolean(meta) && (await verifiedPage({ store, scope, entry: meta, body: existing?.body ?? '' }));
  } catch {
    return false;
  }
}

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

/**
 * Quotes from this conversation that a note rests on. The host checks that each
 * quote exists in a non-injected event of the calling session and records who
 * said it; a quote from the user's own words marks the note current and
 * verified. A quote that does not hold is reported back, never a reason to
 * refuse the write.
 */
const CITATIONS_SCHEMA = Object.freeze({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      quote: { type: 'string' },
      seq: { type: 'integer' },
    },
    required: ['quote'],
  },
  description: 'Exact quotes from this conversation that back the note; checked here.',
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
 * @param {string} scope memory scope ('project').
 * @param {string} [excludeFile] file to skip (memory_update's own target)
 * @param {object} [candidate] candidate text used to rank body reads
 * @returns {Promise<object[]>}
 */
export async function loadPolicyEntries(store, scope, excludeFile = '', candidate = null) {
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
export function policyCandidate({ name, type, description, content }) {
  return {
    name: typeof name === 'string' ? name : '',
    type: typeof type === 'string' ? type : '',
    description: typeof description === 'string' ? description : '',
    content: typeof content === 'string' ? content : '',
  };
}

/**
 * `memory_read` answers with `currentBody()`, so the text a caller edits has no
 * `## History` section. Writing that text back would delete the page's history,
 * so the history rides along unless the new body brings one of its own.
 * @param {unknown} existingBody
 * @param {unknown} content
 * @returns {unknown}
 */
function carriedHistory(existingBody, content) {
  if (typeof content !== 'string') return content;
  if (splitMemoryBody(content).history.length > 0) return content;
  const history = splitMemoryBody(existingBody).history;
  if (history.length === 0) return content;
  return `${content.replace(/\s+$/u, '')}\n\n## History\n\n${history.join('\n')}`;
}

/**
 * Signals for a write that proceeds anyway: a near-duplicate, or a same-topic
 * page that says the opposite. The model decides whether to merge; nothing here
 * blocks the write.
 * @param {object|null} decision `evaluateWrite()` result
 * @returns {{advisory?:boolean, conflicts?:object[], candidates?:object[], hint?:string}}
 */
function advisoryOf(decision) {
  if (decision?.action === 'duplicate') {
    return {
      advisory: true,
      candidates: [{ file: decision.existingFile, similarity: decision.similarity }],
      hint: `Written, but ${decision.existingFile} already covers this. Merge the two with memory_update, and delete the extra copy if they are the same.`,
    };
  }
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

/**
 * Check a write's citations against the calling session. `userHeld` is true when
 * at least one quote the user actually wrote holds: that is what marks a note
 * current and verified.
 */
async function citedBy(runtime, exec, citations) {
  const { evidence, problems } = await checkSessionCitations({ ctx: runtime.ctx, sessionId: sessionIdOf(exec), citations });
  return {
    userHeld: evidence.some((item) => item.role === 'user'),
    fields: {
      ...(evidence.length > 0 ? { citations: evidence.map(({ seq, role }) => ({ seq, role })) } : {}),
      ...(problems.length > 0 ? { citationProblems: problems } : {}),
    },
  };
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

/** The user layer as a project-shaped context (its own store and paths), or undefined. */
async function userLayer(runtime, projectContext) {
  const user = await runtime.userContext?.(projectContext);
  return user ? { ...projectContext, ...user } : undefined;
}

/**
 * Find a note by file name: the project store first, then the user store.
 * @returns {Promise<{ctx:object, label:'project'|'user', entry:object}>}
 */
async function locate(runtime, projectContext, file) {
  const user = await userLayer(runtime, projectContext);
  let missing;
  for (const [label, ctx] of [['project', projectContext], ...(user ? [['user', user]] : [])]) {
    try {
      return { ctx, label, entry: await ctx.store.readEntry(file) };
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') throw error;
      missing ??= error;
    }
  }
  throw missing;
}

/** A write receipt that also warns (never blocks) about sources that do not resolve. */
async function withSourceWarnings(result, root, sources) {
  const check = await checkSources(root, sources);
  if (check.broken.length === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), ...check.broken.map((item) => `source ${item.source}: ${item.status}`)] };
}

/** `sources` parameter: the rules live here, on the parameter, not in the tool description. */
const sourcesSchema = (description) => ({ type: 'array', items: { type: 'string' }, description });

/** Notify the prompt cache owner after a memory write. */
function invalidate(runtime, agent) {
  try {
    runtime.invalidateInjection(agent.id);
  } catch (error) {
    warn('invalidateInjection', error);
  }
}

function subagentReadonly(runtime, exec) {
  if (runtime.canWriteMemory(exec?.agent)) return null;
  return {
    ok: false,
    error: 'subagent-readonly',
    message: 'this subagent session is read-only under the current subagentMemory policy',
  };
}

/**
 * Register the four model-facing `memory_*` tools on the plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} runtime `MemoryRuntime` from `src/runtime.js`.
 * @returns {() => void} disposer removing every tool registration.
 */
export function registerTools(ctx, runtime) {
  const foregroundReads = new Map();
  const readsFor = (exec) => exec?.memoryReadHashes ?? foregroundReads;
  const readHashKey = (exec, project, file) => JSON.stringify([
    exec?.internal === true, sessionIdOf(exec), project.paths?.projectDir, file,
  ]);
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
  const tools = ctx.get('tools');
  if (!tools) {
    warn('tools service', new Error('the tools service is unavailable; memory tools are not registered'));
    return () => {};
  }

  /** @type {Array<() => void>} */
  const disposers = [];
  /** Registered definitions, shared with auto-extract. */
  const definitions = new Map();
  if (runtime && typeof runtime === 'object') runtime.memoryTools = definitions;
  const register = (definition) => {
    const full = { ...definition, description: `${definition.description}${MEMORY_CAUTION}` };
    definitions.set(full.name, full);
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
      'Save one durable memory; cite the words it rests on; skip secrets and repo facts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case name, no extension.' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type.',
        },
        description: { type: 'string', description: 'One-line index summary.' },
        content: { type: 'string', description: 'Markdown details.' },
        sources: sourcesSchema('Repo-relative paths or path#symbol (max 10); anchors, not a code summary.'),
        citations: CITATIONS_SCHEMA,
      },
      required: ['name', 'content'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(runtime, exec);
      if (blocked) return blocked;
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'name must be a non-empty string' };
      }
      if (typeof input.content !== 'string') {
        return { ok: false, error: 'INVALID_ARGUMENT', message: 'content must be a string' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      let projectContext = resolved.projectContext;
      const projectRoot = projectContext.paths?.projectRoot ?? '';
      let scope = 'project';
      let label = 'project';
      let type;
      try {
        type = normalizeType(input.type);
      } catch (error) {
        return toolError(error);
      }
      const source = sourceOf(exec, 'memory_save');
      const candidate = policyCandidate({
        name: input.name,
        type,
        description: input.description,
        content: input.content,
      });
      try {
        const sources = normalizeSources(input.sources);
        // Type user notes belong to the person, not the project: they go to the shared layer.
        if (type === 'user') {
          const user = await userLayer(runtime, projectContext);
          if (user) {
            projectContext = user;
            label = 'user';
          }
        }
        const cited = await citedBy(runtime, exec, input.citations);
        const entries = await loadPolicyEntries(projectContext.store, scope, '', candidate);
        // A near-duplicate or an opposite fact is reported, not refused: the
        // model decides whether to merge.
        const advisory = advisoryOf(evaluateWrite({ candidate, entries, config }));
        // Words the user wrote make this the current value.
        const writeContent = cited.userHeld ? ensureCurrentStatus(input.content) : input.content;
        const hiding = statusHidingPage(undefined, writeContent);
        if (hiding) return { ok: false, error: 'STATUS_HIDES_PAGE', message: statusHidingMessage(hiding, false) };
        const result = await projectContext.store.saveEntry({
          scope,
          name: input.name,
          createOnly: true,
          type,
          description: input.description,
          content: writeContent,
          source,
          sources,
        });
        invalidate(runtime, resolved.agent);
        let verification = 'not-applicable';
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
          if (cited.userHeld) {
            verification = await recordExplicitVerification({
              store: projectContext.store,
              scope,
              file: result.file,
              entry: result,
            });
          }
        }
        if (typeof result?.file === 'string' && result.file !== '' && exec?.internal !== true) {
          runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
        }
        return {
          ...(await withSourceWarnings(result, projectRoot, sources)),
          written: true,
          scope: label,
          verification,
          ...cited.fields,
          ...advisory,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  // ---------------------------------------------------------------- update --
  register({
    name: 'memory_update',
    description:
      'Edit one memory (whole body or one old_text passage) or delete it (recoverable). Read the page before replacing its body.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Memory file name.' },
        name: { type: 'string', description: 'New stable name; renames file/index.' },
        content: { type: 'string', description: 'New body, or the replacement for old_text; omit to keep.' },
        old_text: { type: 'string', description: 'Exact passage to replace with content; kept in History.' },
        description: { type: 'string', description: 'New index summary; omit to keep it.' },
        sources: sourcesSchema('Replaces sources; same rules.'),
        expectedHash: { type: 'string', description: 'Hash from your memory_read result.' },
        delete: { type: 'boolean', description: 'Remove this memory.' },
        citations: CITATIONS_SCHEMA,
      },
      required: ['file'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(runtime, exec);
      if (blocked) return blocked;
      if (typeof input.file !== 'string' || input.file.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'file must be a memory file name' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      let projectContext = resolved.projectContext;
      const projectRoot = projectContext.paths?.projectRoot ?? '';
      let scope = 'project';
      let label = 'project';
      const source = sourceOf(exec, 'memory_update');
      try {
        const sources = normalizeSources(input.sources);
        let existing = null;
        try {
          // Project store first, then the user store.
          ({ ctx: projectContext, label, entry: existing } = await locate(runtime, projectContext, input.file));
        } catch {
          existing = null;
        }
        if (!existing) return { ok: false, error: 'NOT_FOUND', message: `memory file not found: ${input.file}` };
        if (existing.frontmatter?.type === WIKI_TYPE) return { ok: false, error: 'WIKI_READONLY', message: WIKI_READONLY_MESSAGE };
        const currentHash = memoryHash(existing.raw);
        const seenHash = readsFor(exec).get(readHashKey(exec, projectContext, existing.file));
        const wantedHash = typeof input.expectedHash === 'string' && input.expectedHash !== '' ? input.expectedHash : seenHash;
        if (!wantedHash && input.delete !== true && typeof input.content === 'string') {
          return { ok: false, error: 'READ_REQUIRED', message: 'Read this memory before replacing its body.' };
        }
        if (wantedHash && wantedHash !== currentHash) {
          return {
            ok: false,
            error: 'STALE',
            message: 'the file changed since you read it; read it again and merge your change',
            file: input.file,
            expectedHash: wantedHash,
            currentHash,
          };
        }
        if (input.delete === true) {
          await projectContext.store.trashEntry(input.file, { scope, reason: 'memory_update delete', expectedHash: memoryHash(existing.raw) });
          invalidate(runtime, resolved.agent);
          if (exec?.internal !== true) runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
          return { ok: true, deleted: true, file: input.file, scope: label };
        }
        // One passage of the body: the replaced text stays in History.
        let edited = null;
        if (typeof input.old_text === 'string' && input.old_text !== '') {
          if (typeof input.content !== 'string') {
            return { ok: false, error: 'INVALID_ARGUMENT', message: 'old_text needs content: the text that replaces it' };
          }
          edited = replacePassage(existing.body, input.old_text, input.content);
          if (edited.error) {
            return {
              ok: false,
              error: edited.error === 'ambiguous' ? 'OLD_TEXT_AMBIGUOUS' : 'OLD_TEXT_NOT_FOUND',
              message: edited.error === 'ambiguous'
                ? 'old_text matches more than one passage; quote a longer, unique passage'
                : 'old_text is not in the current body; copy it exactly from memory_read',
            };
          }
          if (edited.unchanged) return { ok: true, written: false, unchanged: true, file: existing.file, scope: label };
        }
        const newBody = edited ? edited.body : input.content;
        const candidate = policyCandidate({
          name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name : existing?.frontmatter?.name,
          type: existing?.frontmatter?.type,
          description:
            input.description === undefined ? existing?.frontmatter?.description : input.description,
          content: newBody === undefined ? existing?.body : newBody,
        });
        const entries = await loadPolicyEntries(projectContext.store, scope, existing.file, candidate);
        const cited = await citedBy(runtime, exec, input.citations);
        // v21: a whole-body replace on the user's own words keeps the previous
        // current value as one `Superseded: ... (until ...)` history line.
        const correction =
          cited.userHeld && !edited && typeof input.content === 'string'
            ? composeCorrection({ existingBody: existing.body, content: input.content, source })
            : null;
        const composed = edited ? edited.body
          : (correction?.changed ? correction.content : carriedHistory(existing.body, input.content));
        const writeContent =
          cited.userHeld && typeof composed === 'string'
            ? ensureCurrentStatus(composed)
            : composed;
        const hiding = typeof writeContent !== 'string' ? '' : statusHidingPage(existing.body, writeContent);
        if (hiding) return { ok: false, error: 'STATUS_HIDES_PAGE', message: statusHidingMessage(hiding, false) };
        const advisory = advisoryOf(evaluateWrite({ candidate, entries, config }));
        // A cited new summary or name changes the page fingerprint without
        // restating the body: keep the page's record only if it already had one.
        const keepsVerification = cited.userHeld && typeof input.content !== 'string'
          && (await wasVerified(projectContext.store, scope, existing));
        let result;
        let renameResult = null;
        const wantsRename =
          typeof input.name === 'string' &&
          input.name.trim() !== '' &&
          input.name !== existing?.frontmatter?.name;
        if (wantsRename) {
          // Rename + body/description are one store operation: validation runs
          // before any file is touched, so a rejected update cannot leave a
          // renamed file with stale content.
          renameResult = await projectContext.store.renameEntry(input.file, input.name, {
            scope,
            source,
            expectedHash: memoryHash(existing.raw),
            content: writeContent,
            description: input.description,
            sources,
          });
          result = renameResult;
        } else {
          result = await projectContext.store.updateEntry(input.file, {
            scope,
            content: writeContent,
            description: input.description,
            source,
            sources,
            expectedHash: memoryHash(existing.raw),
          });
        }
        invalidate(runtime, resolved.agent);
        let verification = 'not-applicable';
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
          if (cited.userHeld && (typeof input.content === 'string' || keepsVerification)) {
            verification = await recordExplicitVerification({
              store: projectContext.store,
              scope,
              file: result.file,
              entry: result,
            });
          }
        }
        if (typeof result?.file === 'string' && result.file !== '' && exec?.internal !== true) {
          runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
        }
        // A changed body in a live session is a correction the next Dream should look at.
        if (label === 'project' && typeof result?.file === 'string' && result.file !== '' && !isDelegated(exec?.agent)
          && typeof writeContent === 'string' && currentBody(writeContent) !== currentBody(existing.body)) {
          try {
            await projectContext.state?.noteCorrected?.(result.file);
          } catch (error) {
            warn('noteCorrected', error);
          }
        }
        return {
          ...(await withSourceWarnings({ ...(renameResult ?? {}), ...result }, projectRoot, sources ?? existing.frontmatter?.sources)),
          ...advisory,
          written: true,
          scope: label,
          verification,
          ...cited.fields,
          ...(correction?.changed
            ? {
                correction: {
                  superseded: correction.superseded,
                  until: correction.until,
                  source: correction.source,
                },
              }
            : {}),
        };
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
          apply: { type: 'boolean', description: 'Apply the proposed batch in an evaluation workspace.' },
          sessions: { type: 'boolean', description: 'Read recent session transcripts (default false = pure consolidation).' },
          focus: { type: 'string', description: 'Optional topic to prioritize in this run.' },
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
            focus: typeof input?.focus === 'string' ? input.focus.slice(0, 2_000) : '',
            // C group defaults to pure consolidation; transcript scenarios opt in
            // so the gather/watermark path is evaluated too.
            noSessions: input?.sessions !== true,
          });
          const switched = input?.apply === true && input?.dryRun !== true && result?.ok !== false && result?.ready === true
            ? await runtime.switchDream({ agent, pctx: projectContext, runId: result.runId })
            : null;
          const applied = result?.applied === true || (switched?.ok === true && switched.discarded !== true);
          const error = result?.error || (switched && !applied ? switched.error || 'switch-failed' : '');
          // Keep the result JSON-lossless and small: the tool layer rejects
          // nested plans/signals it cannot serialize losslessly.
          return {
            ok: result?.ok !== false && !error,
            ran: result?.ran === true,
            ready: result?.ready === true,
            runId: result?.runId ?? '',
            ...(error ? { error } : {}),
            applied,
            skipped: result?.skipped === true,
            skipReason: typeof result?.skipReason === 'string' ? result.skipReason : '',
            ops: Number(result?.ops ?? result?.operations?.length ?? 0) || 0,
            filesTouched: result?.files?.length ?? 0,
            counts: result?.counts ?? { added: 0, changed: 0, removed: 0 },
            summary: typeof result?.summary === 'string' ? result.summary : '',
            path: typeof result?.path === 'string' ? result.path : '',
            dryRun: input?.dryRun === true,
            sessionsOffered: Number(result?.sessionsOffered) || 0,
            sessionsRead: Number(result?.sessionsRead) || 0,
            sessionsPartial: Number(result?.sessionsPartial) || 0,
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
      'Read one memory file; superseded values are not included.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Memory file name, e.g. user_role.md.' },
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
        // Project store first, then the user store.
        const { ctx: layer, label, entry } = await locate(runtime, resolved.projectContext, input.file);
        const hashes = readsFor(exec);
        const key = readHashKey(exec, layer, entry.file);
        hashes.delete(key);
        hashes.set(key, memoryHash(entry.raw));
        if (hashes.size > 4096) hashes.delete(hashes.keys().next().value);
        // v23: one read is one read. The counters share a single best-effort
        // block and never hold the reply: the model already has the body.
        Promise.resolve()
          .then(async () => {
            await recordRead(layer.paths, entry.file, sessionIdOf(exec));
          })
          .catch((error) => warn('read metrics', error));
        // `raw` is the whole file, History included; returning it would hand the
        // model the superseded values that `body` leaves out.
        const { raw, ...visible } = entry;
        const check = await checkSources(resolved.projectContext.paths?.projectRoot, entry.frontmatter?.sources);
        return {
          ok: true,
          ...visible,
          scope: label,
          ...(check.items.length > 0 ? { sourcesCheck: check.items, ...(check.broken.length > 0 ? { sourcesNote: brokenNote(check) } : {}) } : {}),
          hash: memoryHash(raw),
          // A read answers "what holds now". Old values stay in the file, the
          // changelog and `/memory history` rather than coming back as current.
          body: currentBody(entry.body),
          status: memoryStatusOf(entry.body),
          ...ageOf(entry),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  // ---------------------------------------------------------------- search --
  register({
    name: 'memory_search',
    description:
      'Search ranked hits; memory_read for details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords; words match independently.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum hits (default 20).' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Only this type.',
        },
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
        // Project hits and user-layer hits, merged by score and labelled with their scope.
        const user = await userLayer(runtime, resolved.projectContext);
        const hits = [];
        for (const [scope, layer] of [['project', resolved.projectContext], ...(user ? [['user', user]] : [])]) {
          const found = await layer.store.search(input.query, { limit: input.limit, type: input.type, currentOnly: true });
          await recordSearch(layer.paths, found.length);
          hits.push(...found.map((hit) => ({ ...hit, scope })));
        }
        hits.sort((a, b) => b.score - a.score);
        hits.length = Math.min(hits.length, Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 20);
        const items = hits.map((hit) => ({
          file: hit.file,
          ...(user ? { scope: hit.scope } : {}),
          name: hit.name,
          description: hit.description,
          type: hit.type,
          score: hit.score,
          via: hit.via ?? '',
          snippets: hit.snippets,
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
    if (runtime && runtime.memoryTools === definitions) runtime.memoryTools = undefined;
    definitions.clear();
    foregroundReads.clear();
  };
}
