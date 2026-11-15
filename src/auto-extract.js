/**
 * Auto-extraction (v24, official shape).
 *
 * After a turn (and when the main agent did not write memory itself), a bounded
 * in-process agent looks at the fresh transcript and the memory index, then
 * uses the same `memory_read` / `memory_search` / `memory_save` tools the main
 * model has. Writes go through the normal save gates (policy, secrets, index
 * budget); there is no second "proposal" pipeline.
 *
 * The loop is capped (turns, items, wall clock) and runs without creating a
 * live Agent/session, so `turn/end` cannot recurse into the scheduler.
 */
import { runToolLoop } from './tool-loop.js';
import { resolveModel, describeLlmError } from './llm-call.js';
import { buildSessionTranscript, chunkTranscript } from './dream-session-text.js';

const CONTENT_MAX = 4_000;
/** Failed tool calls may use at most this much of one extraction window. */
const TOOL_CHARS = 4_000;
const DESCRIPTION_MAX = 240;
const NAME_MAX = 120;
const TOOL_NAMES = ['memory_read', 'memory_search', 'memory_save', 'memory_update'];

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function oneLine(value, max = DESCRIPTION_MAX) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

const EXTRACT_SYSTEM_PROMPT = [
  'You maintain durable memory for a coding assistant after one conversation turn.',
  '',
  'You have memory_read, memory_search, memory_save and memory_update. Use them like the main assistant does:',
  '- Read or search an existing note before writing; update or merge it instead of creating a near-duplicate.',
  '- Save only knowledge a future session cannot recover from the repository, its history, or its instruction files.',
  '- Types: user (stable preferences/role), feedback (a correction or confirmed approach; state the rule, then **Why:** and **How to apply:**), project (ongoing goals/decisions/deadlines the repo does not record), reference (where external information lives).',
  '- Never save secrets, credentials, one-off task chatter, code patterns, file paths, repository structure, git history, or generic debugging recipes.',
  '- Write dates as absolute dates. Do not invent facts: use only the transcript and the notes you read.',
  '- At most ' + '{{MAX_ITEMS}}' + ' memory_save calls. If nothing is durable, save nothing and reply DONE.',
  '',
  'Reply with a one-line summary when finished; do not print JSON.',
].join('\n');

function toolsFrom(runtime) {
  const map = runtime?.memoryTools;
  if (!map || typeof map.get !== 'function') return [];
  const tools = [];
  for (const name of TOOL_NAMES) {
    const definition = map.get(name);
    if (!definition || typeof definition !== 'object') continue;
    if (typeof definition.name !== 'string' || typeof definition.parameters !== 'object') continue;
    tools.push({
      name: definition.name,
      description: String(definition.description ?? ''),
      parameters: definition.parameters,
    });
  }
  return tools;
}

function execFor(agent, sessionId, internal = false) {
  const execAgent = agent && typeof agent.id === 'string' ? agent : { id: sessionId };
  return { agent: execAgent, sessionId, ...(internal ? { internal: true } : {}) };
}

/**
 * Execute one tool call. Save/update are forced to inference+low confidence:
 * the extractor must not claim the user said something verbatim.
 */
async function executeTool(runtime, sessionId, agent, call) {
  if (!TOOL_NAMES.includes(call.name)) {
    return { ok: false, error: 'unknown-tool', message: call.name };
  }
  const definition = runtime?.memoryTools?.get?.(call.name);
  if (!definition || typeof definition.execute !== 'function') {
    return { ok: false, error: 'no-tool', message: `${call.name} is not registered` };
  }
  const args = { ...(call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) };
  let exec;
  if (call.name === 'memory_save') {
    exec = execFor(agent, sessionId, true);
    args.basis = 'inference';
    args.confidence = 'low';
    args.force = false;
    delete args.evidence;
    args.name = oneLine(args.name, NAME_MAX);
    args.description = oneLine(args.description || args.content, DESCRIPTION_MAX);
    args.content = String(args.content ?? '').slice(0, CONTENT_MAX);
  } else if (call.name === 'memory_update') {
    exec = execFor(agent, sessionId, true);
    args.basis = 'inference';
    args.confidence = 'low';
    args.force = false;
    delete args.evidence;
    // Auto-extraction may update a note; it must never delete one.
    delete args.delete;
    delete args.expectedHash;
  } else {
    exec = execFor(agent, sessionId);
  }
  try {
    return await definition.execute(args, exec);
  } catch (error) {
    return { ok: false, error: 'TOOL_FAILED', message: String(error?.message ?? error) };
  }
}

/**
 * One turn-end extraction attempt. Returns a structured result so the caller
 * can record it; never throws.
 */
export async function runAutoExtract({ ctx, runtime, pctx, sessionId, agent, trigger = 'auto' }) {
  const config = runtime.config;
  if (!config.autoExtract || !config.autoMemoryEnabled) return { ok: false, reason: 'disabled' };
  const hostCtx = runtime.ctx ?? ctx;
  const sessionQuery = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('sessionQuery') : undefined;
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') return { ok: false, reason: 'no-session-query' };
  let log;
  try {
    log = await sessionQuery.readSession(sessionId);
  } catch (error) {
    warn('auto-extract readSession', error);
    return { ok: false, reason: 'read-failed' };
  }
  const persisted = Number(pctx?.state?.snapshot?.().extractSeqs?.[sessionId]) || 0;
  const since = Math.max(Number(runtime.extractCursors?.get(sessionId) ?? 0) || 0, persisted);
  const fresh = Array.isArray(log?.events)
    ? log.events.filter((event) => (Number(event?.seq) || 0) > since)
    : [];
  if (fresh.length === 0) return { ok: false, reason: 'no-new-events' };
  // Oldest unread part first: a backlog longer than the budget is read over
  // the next turns instead of losing its head to the cursor.
  const [chunk, ...rest] = chunkTranscript(buildSessionTranscript(fresh), {
    chunkChars: config.autoExtractMaxChars,
    toolCharsPerChunk: TOOL_CHARS,
  });
  const tail = chunk?.text ?? '';
  if (tail.trim().length < 40) return { ok: false, reason: 'empty-transcript' };
  // The cursor is per event: a single message bigger than the budget is read
  // up to the budget once, then passed, so it cannot pin the cursor forever.
  const maxSeq = rest.length > 0
    ? Math.max(chunk.lastSeq, chunk.firstSeq)
    : fresh.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0);

  const model = resolveModel(hostCtx, {
    provider: config.autoExtractProvider,
    model: config.autoExtractModel,
  });
  if (!model) return { ok: false, reason: 'no-model' };
  const tools = toolsFrom(runtime);
  if (tools.length === 0) return { ok: false, reason: 'no-tools' };

  let indexText = '';
  try {
    indexText = (await pctx.store.injectedIndex('project')).text || '';
  } catch {
    indexText = '';
  }

  const maxItems = Math.max(1, Number(config.autoExtractMaxItems) || 5);
  const prompt = [
    'Extract durable memories from the turn transcript below.',
    '',
    indexText.trim() === ''
      ? 'The existing index is empty.'
      : `Existing memory index (read a note before editing it):\n<existing-index>\n${indexText.slice(0, 4_000)}\n</existing-index>`,
    '',
    '<transcript>',
    tail,
    '</transcript>',
    '',
    `Save at most ${maxItems} notes. If nothing is durable, reply DONE.`,
  ].join('\n');

  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Number(config.autoExtractTimeoutMs) || 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let saved = 0;
  let results = [];
  try {
    const loop = await runToolLoop({
      ctx: hostCtx,
      model,
      system: EXTRACT_SYSTEM_PROMPT.replace('{{MAX_ITEMS}}', String(maxItems)),
      prompt,
      tools,
      maxTurns: 5,
      maxTokens: 2_000,
      purpose: 'cc-memory-extract',
      signal: controller.signal,
      executeTool: async (call) => {
        if ((call.name === 'memory_save' || call.name === 'memory_update') && saved >= maxItems) {
          return { ok: false, error: 'limit-reached', message: `at most ${maxItems} writes per turn` };
        }
        const result = await executeTool(runtime, sessionId, agent, call);
        if (call.name === 'memory_save' || call.name === 'memory_update') {
          if (result?.ok !== false) {
            saved += 1;
            results.push({ name: call.arguments?.name ?? call.arguments?.file ?? '', ...result });
          }
        }
        return result;
      },
    });
    if (saved === 0) {
      // A model that answered DONE judged the turn: nothing durable, move on.
      // Only a loop cut off by the turn cap is unfinished and retried.
      if (loop.stopped !== 'stop') {
        return { ok: false, reason: 'max-turns', model, usage: loop.usage };
      }
      runtime.extractCursors?.set(sessionId, maxSeq);
      await pctx?.state?.noteExtractSeq?.(sessionId, maxSeq);
      return { ok: false, reason: 'no-writes', model, usage: loop.usage, maxSeq };
    }
    runtime.extractCursors?.set(sessionId, maxSeq);
    await pctx?.state?.noteExtractSeq?.(sessionId, maxSeq);
    return {
      ok: true,
      mode: 'direct',
      written: saved,
      results,
      model,
      usage: loop.usage,
      turns: loop.turns,
      trigger,
    };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout', model };
    warn('auto-extract model', error);
    return { ok: false, reason: describeLlmError(error), model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply pre-built proposals through the registered `memory_save` definition.
 * Used by the Inbox accept command; auto-extraction writes directly.
 */
export async function applyProposals({ runtime, items, sessionId, agent }) {
  const save = runtime?.memoryTools && typeof runtime.memoryTools.get === 'function'
    ? runtime.memoryTools.get('memory_save')
    : undefined;
  if (!save || typeof save.execute !== 'function') {
    return items.map((item) => ({ name: item.name, ok: false, error: 'no-tools', message: 'memory_save is not registered' }));
  }
  const execAgent = agent && typeof agent.id === 'string' ? agent : { id: sessionId };
  const results = [];
  for (const item of items) {
    try {
      const result = await save.execute(
        {
          name: item.name,
          type: item.type,
          description: item.description,
          content: item.content,
          basis: 'inference',
          confidence: 'low',
          force: false,
        },
        { agent: execAgent, sessionId },
      );
      results.push({ name: item.name, ...result });
    } catch (error) {
      results.push({ name: item.name, ok: false, error: 'EXECUTE_FAILED', message: error?.message ?? String(error) });
    }
  }
  return results;
}
