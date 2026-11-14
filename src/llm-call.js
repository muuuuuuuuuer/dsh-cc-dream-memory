/**
 * Small LLM helper for the v2 dream pipeline.
 *
 * The host exposes `ctx.llm.stream`; this module turns one prompt into text,
 * accumulates usage, and retries once with a larger output budget when the
 * model stops on max-tokens. An optional retry prompt also allows a bounded
 * retry for a transport failure. It never writes memory or state.
 */

const MAX_RETRY_TOKENS = 64_000;

function oneLine(value, max = 300) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function mergeUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const out = total && typeof total === 'object' ? { ...total } : {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isFinite(Number(usage[key]))) out[key] = (Number(out[key]) || 0) + Number(usage[key]);
  }
  return out;
}

/**
 * Use an explicit provider/model pair or the host default selection.
 * @param {object} ctx host context
 * @param {{provider?:string, model?:string}} [explicit]
 * @returns {{provider:string, model:string, reasoningEffort?:unknown}|null}
 */
export function resolveModel(ctx, explicit = {}) {
  let llm;
  try {
    llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  } catch {
    llm = undefined;
  }
  if (!llm || typeof llm.stream !== 'function') return null;
  const provider = typeof explicit.provider === 'string' ? explicit.provider.trim() : '';
  const model = typeof explicit.model === 'string' ? explicit.model.trim() : '';
  if (provider !== '' && model !== '') return { provider, model };
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
    if (selection && typeof selection.provider === 'string' && selection.provider !== ''
      && typeof selection.model === 'string' && selection.model !== '') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Run one text completion with one max-tokens retry.
 * @param {{ctx:object, model:{provider:string,model:string,reasoningEffort?:unknown},
 *   prompt:string, system?:string, signal?:AbortSignal, purpose?:string,
 *   maxTokens?:number, retryPrompt?:()=>string, onUsage?:(usage:object|undefined)=>void}} options
 * @returns {Promise<{text:string, usage:object|null, finishKind:string}>}
 */
export async function streamText({
  ctx,
  model,
  prompt,
  system = '',
  signal,
  purpose = 'cc-memory',
  maxTokens = 16_384,
  retryPrompt,
  onUsage,
} = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable');
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string') {
    throw new Error('llm model unavailable');
  }
  let totalUsage = null;
  const runOnce = async (budget, requestPrompt) => {
    const options = {
      provider: model.provider,
      model: model.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(requestPrompt ?? '') }] }],
      maxTokens: budget,
      purpose,
      ...(system ? { system } : {}),
      ...(signal ? { signal } : {}),
      ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
    };
    const stream = llm.stream(options);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('llm.stream did not return an async iterable');
    }
    let text = '';
    let sawDelta = false;
    let finishKind = '';
    let usage = null;
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        text += chunk.text;
        sawDelta = true;
      } else if (chunk.type === 'block-end' && !sawDelta) {
        const block = chunk.block;
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
      } else if (chunk.type === 'usage') {
        usage = mergeUsage(usage, chunk.usage);
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
    totalUsage = mergeUsage(totalUsage, usage);
    if (typeof onUsage === 'function') onUsage(usage);
    return { text: text.trim(), usage, finishKind };
  };

  const base = Math.max(256, Math.trunc(Number(maxTokens) || 16_384));
  let first;
  try {
    first = await runOnce(base, prompt);
  } catch (error) {
    // The analyzer supplies a cheaper retry request. Keep this limited to
    // transport errors; authentication, aborts, and other failures propagate.
    const transport = /\btransport failed\b/iu.test(String(error?.message ?? ''));
    if (!retryPrompt || !transport || error?.name === 'AbortError' || signal?.aborted) throw error;
  }
  if (first && first.finishKind !== 'max-tokens') return { ...first, usage: totalUsage };
  signal?.throwIfAborted();
  const retry = first ? Math.max(base, Math.min(base * 2, MAX_RETRY_TOKENS)) : base;
  const second = await runOnce(retry, retryPrompt ? retryPrompt() : prompt);
  if (second.finishKind === 'max-tokens') {
    const message = first
      ? `model hit max-tokens twice (maxTokens=${base}, retry=${retry}); reduce this stage's input`
      : `model hit max-tokens after a transport retry (maxTokens=${retry}); reduce this stage's input`;
    const error = new Error(message);
    error.code = 'LLM_MAX_TOKENS';
    throw error;
  }
  return { ...second, usage: totalUsage };
}

/** Compact a stage error for a manifest warning. */
export function describeLlmError(error) {
  return oneLine(error?.message ?? error, 500);
}
