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
import { currentBody, memoryStatusOf } from './memory-body.js';
import { recordAdoption, recordRead, recordSearch, recordWrite } from './metrics.js';
import { evaluateWrite, normalizeBasis, textSimilarity } from './policy.js';
import { normalizeType } from './store.js';
import { verifyUserEvidence, bindUserClaim } from './user-evidence.js';
import { recordVerifiedEntry, verifiedPage } from './verification-ledger.js';
import { composeCorrection, ensureCurrentStatus, memoryHash } from './write-review.js';

/**
 * Record that the host verified a page the user just stated.
 *
 * The ledger is what the next session's injection trusts; a page written
 * without it stays findable by name but never shows a summary until Dream or
 * another explicit write verifies it. A failed ledger write must not undo a
 * successful memory write, so it degrades to a warning.
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
    });
    return record ? 'recorded' : 'pending';
  } catch (error) {
    warn('record verification', error);
    return 'pending';
  }
}

/**
 * True when the ledger already vouched for this page as it is on disk. An edit
 * that leaves the body alone can keep that verification, never create it.
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
 * Write attribution. Every write has one basis; an omitted basis is
 * `inference` (the model's own judgment). Only `user-explicit` with the
 * authorizing user message in `evidence`, which the host verifies against the
 * session transcript (`user-evidence.js`), marks a note current and verified.
 */
const BASIS_SCHEMA = Object.freeze({
  type: 'string',
  enum: ['user-explicit', 'forwarded', 'inference'],
  description: 'Default inference; user-explicit needs evidence.',
});

/**
 * Verbatim user message that authorizes a `user-explicit` write (v22). The host
 * matches it against the session transcript; a quote it cannot find leaves the
 * note written but unverified.
 */
const EVIDENCE_SCHEMA = Object.freeze({
  type: 'string',
  description: 'User message authorizing a user-explicit write; checked here.',
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
const CONFIDENCE_SCHEMA = { type: 'string', enum: ['high', 'low'], description: 'low is reported back.' };

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
 * @param {string} basis `user-explicit` | `forwarded` | `inference`
 * @returns {{sessionId:string, via:string, basis:string}}
 */
function sourceOf(exec, name, basis) {
  const raw = typeof exec?.sessionId === 'string' && exec.sessionId !== '' ? exec.sessionId : exec?.agent?.id;
  return {
    sessionId: typeof raw === 'string' ? raw : '',
    via: `tool:${name}`,
    basis,
  };
}

/**
 * Validate the attribution `basis` argument. Absent means `inference`; an
 * explicit unknown value is an error rather than silently falling back (a typo
 * must not gain write authority).
 * @param {object} input normalized tool arguments
 * @returns {{basis:string}|{error:object}}
 */
function basisOf(input) {
  if (input.basis === undefined || input.basis === null || input.basis === '') return { basis: 'inference' };
  const basis = normalizeBasis(input.basis);
  if (basis === '') {
    return {
      error: {
        ok: false,
        error: 'INVALID_ARGUMENT',
        message: 'basis must be one of: user-explicit, forwarded, inference',
      },
    };
  }
  return { basis };
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
function policyCandidate({ name, type, description, content, confidence }) {
  return {
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
  if (Array.isArray(decision.reasons) && decision.reasons.length > 0) result.reasons = decision.reasons;
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

/**
 * Stop reasons that are not a review queue (v24, Claude Code parity). A write
 * that would add a second active copy of a fact stops and names the page that
 * owns it; the model then edits that page. Everything else is written.
 * @param {object|null} decision `evaluateWrite()` result
 * @returns {object|null} tool result when the write must stop
 */
function writeStopped(decision) {
  if (decision && decision.action === 'duplicate') {
    return {
      ok: false,
      error: 'DUPLICATE',
      existingFile: decision.existingFile,
      similarity: decision.similarity,
      message: `${decision.existingFile} already covers this memory; update it instead of adding a copy`,
      hint: 'use memory_update on that file, or pass force:true for an intentional duplicate',
    };
  }
  if (decision && decision.action === 'conflict') {
    const conflicts = Array.isArray(decision.conflicts) ? decision.conflicts : [];
    const first = conflicts[0];
    return {
      ok: false,
      error: 'CONFLICT',
      existingFile: first.file,
      conflicts,
      message: `opposite fact already active in ${first.file}: ${first.reason}`,
      hint: `update ${first.file} instead of adding a second active fact`,
    };
  }
  return null;
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
  /** Registered definitions, shared with auto-extract and Inbox accept. */
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
      'Save one durable memory; state its basis; skip secrets and repo facts.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stable name, no extension.' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type.',
        },
        description: { type: 'string', description: 'One-line index summary.' },
        content: { type: 'string', description: 'Markdown details.' },
        basis: BASIS_SCHEMA,
        evidence: { type: 'string' },
        confidence: CONFIDENCE_SCHEMA,
        force: { type: 'boolean', description: 'Allow duplicate.' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(runtime, exec);
      if (blocked) return blocked;
      const basisInfo = basisOf(input);
      if (basisInfo.error) return basisInfo.error;
      const basis = basisInfo.basis;
      // A basis is a proposal, not proof: the host checks the quoted user
      // message against this session's transcript before it grants authority.
      const evidenceCheck = basis === 'user-explicit'
        ? await verifyUserEvidence({ ctx: runtime.ctx, sessionId: sessionIdOf(exec), quote: input.evidence })
        : { verified: false, reason: '' };
      // A located quote proves who spoke, not what they agreed to: the sentences
      // this write adds must also come from that message.
      const binding = evidenceCheck.verified && typeof input.content === 'string'
        ? bindUserClaim({ evidence: input.evidence, content: input.content })
        : { ok: true, unbound: [] };
      const verifiedEvidence = evidenceCheck.verified && binding.ok ? input.evidence : '';
      const evidenceReason = evidenceCheck.reason !== ''
        ? evidenceCheck.reason
        : (binding.ok ? '' : `\`evidence\` does not contain the claim being written: ${binding.unbound.slice(0, 3).join(' | ')}`);
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'name must be a non-empty string' };
      }
      if (typeof input.content !== 'string') {
        return { ok: false, error: 'INVALID_ARGUMENT', message: 'content must be a string' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      const projectContext = resolved.projectContext;
      let scope = 'project';
      let type;
      try {
        type = normalizeType(input.type);
      } catch (error) {
        return toolError(error);
      }
      const source = sourceOf(exec, 'memory_save', basis);
      const candidate = policyCandidate({
        name: input.name,
        type,
        description: input.description,
        content: input.content,
        confidence: input.confidence,
      });
      try {
        const entries = await loadPolicyEntries(projectContext.store, scope, '', candidate);
        // Nothing queues (Claude Code parity): a duplicate or an opposite fact
        // stops the write so the model edits the page that owns the fact;
        // every other outcome is written and reported as an advisory.
        const decision = input.force === true
          ? { action: 'allow' }
          : evaluateWrite({ candidate, entries, config });
        const stopped = writeStopped(decision);
        if (stopped) {
          return {
            ...stopped,
            basis,
            scope,
            ...(evidenceReason === '' ? {} : { evidenceCheck: evidenceReason }),
          };
        }
        const advisory = input.force === true ? {} : advisoryOf(decision);
        // A verified user statement is the current value: mark it active so the
        // next session can show its summary instead of only its name. The
        // marker is added after the evidence binding, so it never counts as a
        // model-invented claim.
        const writeContent = verifiedEvidence !== '' ? ensureCurrentStatus(input.content) : input.content;
        // What the index may claim is decided by the ledger, not here: a summary
        // that does not belong to the verified bytes renders as a bare name in
        // the first-turn index (src/inject.js).
        const result = await projectContext.store.saveEntry({
          scope,
          name: input.name,
          type,
          description: input.description,
          content: writeContent,
          source,
        });
        invalidate(runtime, resolved.agent);
        let verification = 'not-applicable';
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
          if (verifiedEvidence !== '') {
            verification = await recordExplicitVerification({
              store: projectContext.store,
              scope,
              file: result.file,
              entry: result,
            });
          }
        }
        if (typeof result?.file === 'string' && result.file !== '') {
          runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
        }
        return {
          ...result,
          written: true,
          basis,
          scope,
          verification,
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
      'Edit one memory or delete it (recoverable).',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Memory file name.' },
        name: { type: 'string', description: 'New stable name; renames file/index.' },
        content: { type: 'string', description: 'New body; omit to keep.' },
        description: { type: 'string', description: 'New index summary; omit to keep it.' },
        delete: { type: 'boolean', description: 'Remove this memory.' },
        basis: BASIS_SCHEMA,
        evidence: { type: 'string' },
        confidence: CONFIDENCE_SCHEMA,
        force: { type: 'boolean', description: 'Allow duplicate.' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec) {
      const input = argsOf(args);
      if (!autoMemoryOn(config)) return autoMemoryDisabled(config);
      const blocked = subagentReadonly(runtime, exec);
      if (blocked) return blocked;
      const basisInfo = basisOf(input);
      if (basisInfo.error) return basisInfo.error;
      const basis = basisInfo.basis;
      const evidenceCheck = basis === 'user-explicit'
        ? await verifyUserEvidence({ ctx: runtime.ctx, sessionId: sessionIdOf(exec), quote: input.evidence })
        : { verified: false, reason: '' };
      if (typeof input.file !== 'string' || input.file.trim() === '') {
        return { ok: false, error: 'INVALID_NAME', message: 'file must be a memory file name' };
      }
      const resolved = await projectFor(runtime, exec);
      if (resolved.error) return resolved.error;
      const projectContext = resolved.projectContext;
      let scope = 'project';
      try {
      } catch (error) {
        return toolError(error);
      }
      const source = sourceOf(exec, 'memory_update', basis);
      try {
        let existing = null;
        try {
          existing = await projectContext.store.readEntry(input.file, scope);
        } catch {
          existing = null;
        }
        if (!existing) return { ok: false, error: 'NOT_FOUND', message: `memory file not found: ${input.file}` };
        if (input.delete === true) {
          await projectContext.store.trashEntry(input.file, { scope, reason: 'memory_update delete', expectedHash: memoryHash(existing.raw) });
          invalidate(runtime, resolved.agent);
          runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
          return { ok: true, deleted: true, file: input.file, scope };
        }
        const candidate = policyCandidate({
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
        // A located quote proves who spoke, not what they agreed to: new
        // sentences must come from that same message.
        const binding = evidenceCheck.verified && typeof input.content === 'string'
          ? bindUserClaim({ evidence: input.evidence, content: input.content, previous: existing.body })
          : { ok: true, unbound: [] };
        const verifiedEvidence = evidenceCheck.verified && binding.ok ? input.evidence : '';
        const evidenceReason = evidenceCheck.reason !== ''
          ? evidenceCheck.reason
          : (binding.ok ? '' : `\`evidence\` does not contain the claim being written: ${binding.unbound.slice(0, 3).join(' | ')}`);
        // v21: an explicit user correction keeps the previous current value as
        // one `Superseded: ... (until ...)` history line in the owning topic.
        const correction =
          basis === 'user-explicit' && typeof input.content === 'string'
            ? composeCorrection({ existingBody: existing.body, content: input.content, source })
            : null;
        const composed = correction?.changed ? correction.content : input.content;
        const writeContent =
          verifiedEvidence !== '' && typeof composed === 'string'
            ? ensureCurrentStatus(composed)
            : composed;
        const decision = input.force === true
          ? { action: 'allow' }
          : evaluateWrite({ candidate, entries, config });
        const stopped = writeStopped(decision);
        if (stopped) {
          return {
            ...stopped,
            basis,
            scope,
            ...(evidenceReason === '' ? {} : { evidenceCheck: evidenceReason }),
            ...(correction?.changed
              ? { correction: { superseded: correction.superseded, until: correction.until, source: correction.source } }
              : {}),
          };
        }
        const advisory = input.force === true ? {} : advisoryOf(decision);
        // A confirmed new summary or name changes the page fingerprint without
        // restating the body: keep the page verified only if it already was and
        // the new summary is backed by the same quote.
        const keepsVerification = verifiedEvidence !== '' && typeof input.content !== 'string'
          && (typeof input.description !== 'string'
            || bindUserClaim({ evidence: verifiedEvidence, content: input.description, previous: existing?.frontmatter?.description ?? '' }).ok)
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
          });
          result = renameResult;
        } else {
          result = await projectContext.store.updateEntry(input.file, {
            scope,
            content: writeContent,
            description: input.description,
            source,
            expectedHash: memoryHash(existing.raw),
          });
        }
        invalidate(runtime, resolved.agent);
        let verification = 'not-applicable';
        if (typeof result?.file === 'string' && result.file !== '') {
          await recordWrite(projectContext.paths, result.file);
          if (verifiedEvidence !== '' && (typeof input.content === 'string' || keepsVerification)) {
            verification = await recordExplicitVerification({
              store: projectContext.store,
              scope,
              file: result.file,
              entry: result,
            });
          }
        }
        if (typeof result?.file === 'string' && result.file !== '') {
          runtime.noteMemoryWrite?.(sessionIdOf(exec), Date.now());
        }
        return {
          ...(renameResult ?? {}),
          ...result,
          ...advisory,
          written: true,
          basis,
          scope,
          verification,
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
        const entry = await resolved.projectContext.store.readEntry(input.file);
        // v23: one read is one read. The counters share a single best-effort
        // block and never hold the reply: the model already has the body.
        Promise.resolve()
          .then(async () => {
            await recordRead(resolved.projectContext.paths, entry.file);
            await recordAdoption(resolved.projectContext.paths, entry.file, sessionIdOf(exec));
          })
          .catch((error) => warn('read metrics', error));
        return {
          ok: true,
          ...entry,
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
        query: { type: 'string', description: 'Keywords or phrase; space-separated words match independently.' },
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
        const hits = await resolved.projectContext.store.search(input.query, {
          limit: input.limit,
          type: input.type,
          currentOnly: true,
        });
        await recordSearch(resolved.projectContext.paths, hits.length);
        const items = hits.map((hit) => ({
          file: hit.file,
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
  };
}
