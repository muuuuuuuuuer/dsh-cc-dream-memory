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
import { MEMORY_SELECTION } from './rules.js';
import { resolveModel, describeLlmError } from './llm-call.js';
import { buildSessionTranscript, chunkTranscript } from './dream-session-text.js';

const CONTENT_MAX = 4_000;
/** Failed tool calls may use at most this much of one extraction window. */
const TOOL_CHARS = 4_000;
const DESCRIPTION_MAX = 240;
const NAME_MAX = 120;
const TOOL_NAMES = ['memory_read', 'memory_search', 'memory_save', 'memory_update'];
/** Tools that reach outside the project: MCP servers and the web tools. */
const EXTERNAL_TOOL_RE = /^(mcp__|web_search$|web_fetch$)/;

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
  '- Corrections first: when the user corrected something an existing note says, edit the matching passage of that note via memory_update instead of writing a new note. Change only the wrong passage and keep the conditions that still hold.',
  MEMORY_SELECTION,
  'If the transcript has no candidate, finish without reading the index entries or calling tools.',
  '- Types: user (role, expertise or durable background), feedback (how the user wants you to work, a correction or confirmed approach), project (goals, decisions, deadlines or run facts absent from the repo), reference (where external information lives). Keep a simple preference to one sentence. Add **Why:** or **How to apply:** only for a stated reason or a non-obvious application the user confirmed.',
  '- When a note rests on words the user wrote, cite them: citations:[{quote:"<exact words>"}]. The host checks the quote exists and who said it.',
  '- Never save secrets, credentials, one-off task chatter, or generic debugging recipes.',
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
 * Execute one tool call. The extractor is the same model with the same tools
 * and the same citation check as the main session; the one limit it keeps is
 * that it never deletes.
 */
async function executeTool(runtime, sessionId, agent, call, memoryReadHashes) {
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
    args.name = oneLine(args.name, NAME_MAX);
    args.description = oneLine(args.description || args.content, DESCRIPTION_MAX);
    args.content = String(args.content ?? '');
    // Refuse instead of cutting: a cut note saves fine and the tail is lost
    // without anyone knowing. The model gets the reason and can retry.
    if (args.content.length > CONTENT_MAX) {
      return {
        ok: false,
        error: 'TOO_LONG',
        message: `content is ${args.content.length} characters; the limit is ${CONTENT_MAX}. Nothing was saved. Shorten it, or split it into separate notes, and save again.`,
      };
    }
  } else if (call.name === 'memory_update') {
    exec = execFor(agent, sessionId, true);
    // Auto-extraction may update a note; it must never delete one.
    delete args.delete;
  } else {
    exec = execFor(agent, sessionId);
  }
  try {
    return await definition.execute(args, { ...exec, internal: true, memoryReadHashes });
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
  const checkpoint = pctx?.state?.snapshot?.();
  const persisted = Number(checkpoint?.extractSeqs?.[sessionId]) || 0;
  const since = Math.max(Number(runtime.extractCursors?.get(sessionId) ?? 0) || 0, persisted);
  const fresh = Array.isArray(log?.events)
    ? log.events.filter((event) => (Number(event?.seq) || 0) > since)
    : [];
  if (fresh.length === 0) return { ok: false, reason: 'no-new-events' };
  // Oldest unread part first: a backlog longer than the budget is read over
  // the next turns instead of losing its head to the cursor.
  const [chunk] = chunkTranscript(buildSessionTranscript(fresh), {
    chunkChars: config.autoExtractMaxChars,
    toolCharsPerChunk: TOOL_CHARS,
    resume: checkpoint?.extractOffsets?.[sessionId],
  });
  const tail = chunk?.text ?? '';
  if (!tail.trim()) return { ok: false, reason: 'empty-transcript' };
  const maxSeq = Math.max(since, chunk.lastSeq);
  // `autoExtractSkipExternal`: a window that called outside tools is not mined.
  // The cursor still moves, so the same window is not offered again.
  if (config.autoExtractSkipExternal === true && fresh.some((event) => (Number(event?.seq) || 0) <= maxSeq
    && event?.type === 'tool/call' && EXTERNAL_TOOL_RE.test(String(event.data?.name ?? '')))) {
    await pctx?.state?.noteExtractSeq?.(sessionId, maxSeq, chunk.nextOffset);
    runtime.extractCursors?.set(sessionId, maxSeq);
    return { ok: false, reason: 'external-tools', maxSeq };
  }

  const model = resolveModel(hostCtx, {
    provider: config.autoExtractProvider,
    model: config.autoExtractModel,
  });
  if (!model) return { ok: false, reason: 'no-model' };
  const tools = toolsFrom(runtime);
  if (tools.length === 0) return { ok: false, reason: 'no-tools' };

  let indexText = '';
  let userIndexText = '';
  try {
    indexText = (await pctx.store.injectedIndex('project')).text || '';
    userIndexText = (await (await runtime.userContext?.(pctx))?.store.injectedIndex('project'))?.text || '';
  } catch {
    /* an unreadable index only means less context for the extractor */
  }

  const maxItems = Math.max(1, Number(config.autoExtractMaxItems) || 5);
  const rules = runtime.rulesFor?.(pctx)?.text || '';
  const prompt = [
    'Extract durable memories from the turn transcript below.',
    rules.trim() === '' ? '' : `Project memory rules (follow these over your defaults):\n${rules}`,
    '',
    indexText.trim() === ''
      ? 'The existing index is empty.'
      : `Existing memory index (read a note before editing it):\n<existing-index>\n${indexText.slice(0, 4_000)}\n</existing-index>`,
    userIndexText.trim() === ''
      ? ''
      : `User notes shared by every project (type user is saved there):
<user-index>
${userIndexText.slice(0, 2_000)}
</user-index>`,
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
  const memoryReadHashes = new Map();
  const pendingWrites = new Set();
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
        const write = call.name === 'memory_save' || call.name === 'memory_update';
        const key = String(call.arguments?.file ?? call.arguments?.name ?? call.name);
        if (write && saved >= maxItems) {
          pendingWrites.add(key);
          return { ok: false, error: 'limit-reached', message: `at most ${maxItems} writes per turn` };
        }
        const result = await executeTool(runtime, sessionId, agent, call, memoryReadHashes);
        if (write) {
          const target = result?.existingFile ?? key;
          if (result?.ok === true || result?.written === true) {
            pendingWrites.delete(key);
            pendingWrites.delete(result.file);
            saved += 1;
            results.push({ name: call.arguments?.name ?? call.arguments?.file ?? '', ...result });
          } else if (result?.error !== 'SECRET_DETECTED') {
            pendingWrites.add(target);
          }
        }
        return result;
      },
    });
    if (loop.stopped !== 'stop') {
      return { ok: false, reason: loop.stopped, written: saved, model, usage: loop.usage };
    }
    if (pendingWrites.size > 0) {
      return { ok: false, reason: 'write-incomplete', written: saved, model, usage: loop.usage };
    }
    await pctx?.state?.noteExtractSeq?.(sessionId, maxSeq, chunk.nextOffset);
    runtime.extractCursors?.set(sessionId, maxSeq);
    if (saved === 0) return { ok: false, reason: 'no-writes', model, usage: loop.usage, maxSeq };
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
