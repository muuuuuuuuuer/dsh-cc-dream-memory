/**
 * Model resolution and a single streamed text completion.
 */

function oneLine(value, max = 300) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
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
 * Run one text completion and report its finish reason.
 * @param {{ctx:object, model:{provider:string,model:string,reasoningEffort?:unknown},
 *   prompt:string, system?:string, signal?:AbortSignal, purpose?:string,
 *   maxTokens?:number}} options
 * @returns {Promise<{text:string, finishKind:string}>}
 */
export async function streamText({
  ctx,
  model,
  prompt,
  system = '',
  signal,
  purpose = 'cc-memory',
  maxTokens = 16_384,
} = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable');
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string') {
    throw new Error('llm model unavailable');
  }
  signal?.throwIfAborted();
  const stream = llm.stream({
    provider: model.provider,
    model: model.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
    maxTokens,
    purpose,
    ...(system ? { system } : {}),
    ...(signal ? { signal } : {}),
    ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
  });
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('llm.stream did not return an async iterable');
  }
  let text = '';
  let sawDelta = false;
  let finishKind = '';
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
      text += chunk.text;
      sawDelta = true;
    } else if (chunk.type === 'block-end' && !sawDelta) {
      const block = chunk.block;
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    } else if (chunk.type === 'finish') {
      finishKind = chunk.reason?.kind ?? '';
      if (finishKind === 'error' || finishKind === 'aborted') {
        throw new Error(chunk.reason?.failure?.message || `llm request ${finishKind}`);
      }
    }
  }
  return { text: text.trim(), finishKind };
}

/** Compact a stage error for a manifest warning. */
export function describeLlmError(error) {
  return oneLine(error?.message ?? error, 500);
}
