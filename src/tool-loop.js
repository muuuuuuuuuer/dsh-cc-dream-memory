/**
 * One small in-process tool loop.
 *
 * Claude Code's extractor and dream are agents with a few tools. DSH already
 * exposes the same primitive: `llm.stream` accepts tool schemas and reports
 * tool calls. This module runs that loop without creating a live Agent or a
 * session, so a turn-end hook cannot recurse into the scheduler.
 *
 * The caller owns the tools and their side effects. This module only:
 * - sends the messages and schemas,
 * - collects streamed text and tool calls,
 * - appends the assistant/tool messages for the next turn,
 * - stops at `maxTurns` or when the model stops calling tools.
 */

import { randomUUID } from 'node:crypto';

const MAX_TOOL_RESULT_CHARS = 12_000;

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

function mergeUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const out = total && typeof total === 'object' ? { ...total } : {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(Number(usage[key]))) out[key] = (Number(out[key]) || 0) + Number(usage[key]);
  }
  return out;
}

/** Total tokens of a merged usage record (total, else input + output). */
function totalOf(usage) {
  if (!usage) return 0;
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  return (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
}

function clip(value, max = MAX_TOOL_RESULT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function argumentsOf(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** Host message for a request that never got a usable response. */
const TRANSPORT_FAILURE_RE = /\btransport failed\b/iu;
const TRANSPORT_RETRY_DELAY_MS = 1_000;

/**
 * @param {{
 *   ctx: object,
 *   model: {provider:string, model:string, reasoningEffort?:unknown},
 *   system: string,
 *   prompt: string,
 *   tools: Array<object>,
 *   executeTool: (call:{id:string,name:string,arguments:object}) => Promise<unknown>|unknown,
 *   maxTurns?: number,
 *   maxTokens?: number,
 *   purpose?: string,
 *   signal?: AbortSignal,
 *   onUsage?: (usage:object|undefined)=>void,
 *   maxTotalTokens?: number,
 * }} options `maxTotalTokens` (0 = off) stops before the next model call once
 *   the reported usage reaches it; the tools of the last turn still ran.
 * @returns {Promise<{text:string, turns:number, toolCalls:Array<object>, usage:object|null, stopped:string}>}
 */
export async function runToolLoop({
  ctx,
  model,
  system = '',
  prompt,
  tools = [],
  executeTool,
  maxTurns = 5,
  maxTokens = 2_000,
  purpose = 'cc-memory',
  signal,
  onUsage,
  maxTotalTokens = 0,
} = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable');
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string') {
    throw new Error('llm model unavailable');
  }
  if (typeof executeTool !== 'function') throw new Error('executeTool is required');

  const messages = [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }];
  const calls = [];
  let usage = null;
  let text = '';
  let turns = 0;
  const cap = Math.max(1, Math.trunc(Number(maxTurns) || 5));

  const budget = Math.max(0, Math.trunc(Number(maxTotalTokens) || 0));

  while (turns < cap) {
    signal?.throwIfAborted();
    if (budget > 0 && totalOf(usage) >= budget) return { text, turns, toolCalls: calls, usage, stopped: 'budget' };
    turns += 1;
    // One model turn. A transport failure (dropped connection, gateway error)
    // is retried once; the partial turn is thrown away, so nothing is doubled.
    const streamTurn = async () => {
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        messages,
        maxTokens,
        purpose,
        ...(system ? { system } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(signal ? { signal } : {}),
        ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
      });
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new Error('llm.stream did not return an async iterable');
      }

      const blocks = new Map();
      let assistantText = '';
      let finishKind = '';
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          assistantText += chunk.text;
        } else if (chunk.type === 'tool-call-delta') {
          const key = chunk.id ?? chunk.index ?? `call-${blocks.size}`;
          const current = blocks.get(key) || { type: 'tool-call', id: String(key), name: '', arguments: '' };
          if (typeof chunk.name === 'string' && chunk.name !== '') current.name = chunk.name;
          if (typeof chunk.argumentsDelta === 'string') current.arguments += chunk.argumentsDelta;
          blocks.set(key, current);
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          const block = chunk.block;
          const key = block.id ?? `call-${blocks.size}`;
          blocks.set(key, {
            type: 'tool-call',
            id: String(key),
            name: String(block.name ?? ''),
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          });
        } else if (chunk.type === 'usage') {
          usage = mergeUsage(usage, chunk.usage);
          if (typeof onUsage === 'function') onUsage(chunk.usage);
        } else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind ?? '';
          if (finishKind === 'error' || finishKind === 'aborted') {
            const failure = chunk.reason?.failure;
            const error = new Error((failure && failure.message) || `llm request ${finishKind}`);
            if (failure && failure.code) error.code = failure.code;
            error.name = finishKind === 'aborted' ? 'AbortError' : 'LlmError';
            throw error;
          }
        }
      }
      return { blocks, assistantText, finishKind };
    };
    let turn;
    try {
      turn = await streamTurn();
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted || !TRANSPORT_FAILURE_RE.test(String(error?.message ?? ''))) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS));
      signal?.throwIfAborted();
      turn = await streamTurn();
    }
    const { blocks, assistantText, finishKind } = turn;

    text = assistantText.trim();
    signal?.throwIfAborted();
    if (finishKind !== 'stop' && finishKind !== 'tool-calls') {
      return { text, turns, toolCalls: calls, usage, stopped: finishKind || 'incomplete-stream' };
    }
    const toolCalls = [...blocks.values()]
      .filter((block) => block.name !== '')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: argumentsOf(block.arguments),
      }));
    if (toolCalls.length === 0) {
      return { text, turns, toolCalls: calls, usage, stopped: finishKind === 'stop' ? 'stop' : 'incomplete-tool-call' };
    }

    messages.push({
      id: randomUUID(),
      role: 'assistant',
      source: { kind: 'model', provider: model.provider, model: model.model },
      content: [
        ...(text !== '' ? [{ type: 'text', text }] : []),
        ...toolCalls.map((call) => ({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      ],
    });

    for (const call of toolCalls) {
      signal?.throwIfAborted();
      calls.push(call);
      let result;
      try {
        result = await executeTool(call);
      } catch (error) {
        warn(`tool ${call.name}`, error);
        result = { ok: false, error: 'TOOL_FAILED', message: String(error?.message ?? error) };
      }
      const content = clip(result);
      messages.push({
        id: randomUUID(),
        role: 'tool',
        source: { kind: 'tool', callId: call.id },
        toolCallId: call.id,
        content: [{ type: 'text', text: content }],
      });
    }
  }

  return { text, turns, toolCalls: calls, usage, stopped: 'max-turns' };
}

export { textOf };
