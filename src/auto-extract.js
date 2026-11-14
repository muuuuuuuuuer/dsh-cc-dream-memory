/**
 * Auto-extraction (v20, opt-in).
 *
 * One turn-end hook: after the main agent finishes a turn (and did not write
 * memory itself), a bounded extractor reads the recent transcript tail and
 * proposes durable notes. The proposal is staged in the Inbox so a human can
 * accept it; accepting replays it through the normal `memory_save` gates.
 * There is deliberately no direct-write mode.
 *
 * This deliberately does NOT create a live Agent/session: a plugin-owned
 * one-shot call keeps the scheduler from recursing and keeps the extractor out
 * of the transcript/UI. The prompt still says "recent messages only" and the
 * host re-validates every write (policy, evidence, secrets, budget).
 */
import { resolveModel, streamText, describeLlmError } from './llm-call.js';
import { buildSessionTranscript } from './dream-session-text.js';
import { writeProposal } from './inbox.js';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const CONTENT_MAX = 4_000;
const DESCRIPTION_MAX = 240;
const NAME_MAX = 120;

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function oneLine(value, max = DESCRIPTION_MAX) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Keep only well-formed proposals; the model is untrusted input. */
export function parseExtraction(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return [];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.memories) ? parsed.memories : []);
  const items = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, NAME_MAX) : '';
    const content = typeof entry.content === 'string' ? entry.content.trim().slice(0, CONTENT_MAX) : '';
    if (name === '' || content === '') continue;
    const type = TYPES.has(entry.type) ? entry.type : 'project';
    const description = entry.description
      ? oneLine(entry.description)
      : oneLine(content);
    items.push({ name, type, description, content });
  }
  return items;
}

/**
 * The last `maxChars` of the conversation, cut at a block boundary.
 * Tool calls/results are included: a decision often lives next to a failure.
 */
export function transcriptTail(transcript, maxChars = 12_000) {
  const blocks = Array.isArray(transcript?.blocks) ? transcript.blocks : [];
  const parts = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block || typeof block.text !== 'string' || block.text === '') continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const text = block.text.length <= remaining ? block.text : block.text.slice(block.text.length - remaining);
    parts.unshift(text);
    used += text.length;
  }
  return parts.join('\n\n');
}

const EXTRACT_SYSTEM_PROMPT = [
  'You extract durable memories for a coding assistant. Read the recent transcript and return only facts that will help a future session.',
  '',
  'Types:',
  '- user: stable preferences, role, working style, constraints.',
  '- feedback: a correction or confirmed approach, with **Why:** and **How to apply:**.',
  '- project: ongoing work, goals, decisions, deadlines that the repository does not record.',
  '- reference: where external information lives (URLs, dashboards, tickets).',
  '',
  'Never extract code patterns, file paths, repository structure, git history, generic debugging recipes, secrets/credentials, or one-off task chatter. Do not save something the user did not say or the transcript does not show. Convert relative dates to absolute dates (today is the transcript date).',
  'For feedback and project notes, state the fact first, then **Why:** and **How to apply:** when the transcript supports them.',
  'Return JSON only: {"memories":[{"name":"stable short name","type":"user|feedback|project|reference","description":"one line","content":"concise markdown"}]}. Return {"memories":[]} when nothing is durable.',
].join('\n');

/**
 * Ask the model for proposals. Returns `{items, model, usage}` or a reason.
 * Never throws for an ordinary model failure: auto-extract is best-effort.
 */
export async function extractProposals({ ctx, runtime, pctx, sessionId, agent, trigger = 'auto' }) {
  const config = runtime.config;
  if (!config.autoExtract || !config.autoMemoryEnabled) return { ok: false, reason: 'disabled' };
  const sessionQuery = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') return { ok: false, reason: 'no-session-query' };
  let log;
  try {
    log = await sessionQuery.readSession(sessionId);
  } catch (error) {
    warn('auto-extract readSession', error);
    return { ok: false, reason: 'read-failed' };
  }
  const since = Number(runtime.extractCursors?.get(sessionId) ?? 0) || 0;
  const fresh = Array.isArray(log?.events)
    ? log.events.filter((event) => (Number(event?.seq) || 0) > since)
    : [];
  if (fresh.length === 0) return { ok: false, reason: 'no-new-events' };
  const transcript = buildSessionTranscript(fresh);
  const tail = transcriptTail(transcript, config.autoExtractMaxChars);
  if (tail.trim().length < 40) return { ok: false, reason: 'empty-transcript' };
  const maxSeq = fresh.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0);

  const model = resolveModel(runtime.ctx ?? ctx, {
    provider: config.autoExtractProvider,
    model: config.autoExtractModel,
  });
  if (!model) return { ok: false, reason: 'no-model' };

  let indexText = '';
  try {
    indexText = (await pctx.store.injectedIndex('project')).text || '';
  } catch {
    indexText = '';
  }

  const prompt = [
    'Extract at most ' + String(config.autoExtractMaxItems) + ' durable memories from the recent transcript below.',
    '',
    indexText.trim() === ''
      ? 'The existing index is empty.'
      : `Existing index (do not duplicate these; update is a human decision):\n<existing-index>\n${indexText.slice(0, 4_000)}\n</existing-index>`,
    '',
    '<transcript>',
    tail,
    '</transcript>',
  ].join('\n');

  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Number(config.autoExtractTimeoutMs) || 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await streamText({
      ctx: runtime.ctx ?? ctx,
      model,
      system: EXTRACT_SYSTEM_PROMPT,
      prompt,
      signal: controller.signal,
      purpose: 'cc-memory-extract',
      maxTokens: 1_600,
    });
    const items = parseExtraction(result.text).slice(0, config.autoExtractMaxItems);
    if (items.length === 0) return { ok: false, reason: 'no-proposals', model, usage: result.usage, maxSeq };
    return { ok: true, items, model, usage: result.usage, trigger, agent, maxSeq };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout', model };
    warn('auto-extract model', error);
    return { ok: false, reason: describeLlmError(error), model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply proposals through the registered `memory_save` definition. The host
 * still enforces policy, secret scanning, evidence binding and the index
 * budget; a rejected note is reported, never silently dropped.
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

/**
 * One turn-end extraction attempt. Returns a structured result so the caller
 * can record it; never throws.
 */
export async function runAutoExtract({ ctx, runtime, pctx, sessionId, agent, trigger = 'auto' }) {
  const config = runtime.config;
  if (!config.autoExtract || !config.autoMemoryEnabled) return { ok: false, reason: 'disabled' };
  const extracted = await extractProposals({ ctx, runtime, pctx, sessionId, agent, trigger });
  if (!extracted.ok) return extracted;
  const record = await writeProposal(pctx.paths, {
    sessionId,
    cwd: pctx.workspaceDir,
    items: extracted.items,
    model: extracted.model,
    trigger,
  });
  if (!record) return { ok: false, reason: 'inbox-full' };
  runtime.extractCursors?.set(sessionId, extracted.maxSeq ?? 0);
  return { ok: true, mode: 'inbox', id: record.id, count: record.items.length, model: extracted.model };
}
