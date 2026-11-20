/**
 * LongMemEval-S harness pieces: the dataset as host sessions, a DeepSeek
 * Messages adapter in the plugin's `llm.stream` chunk protocol, a Dream child
 * played by the same model through the plugin's own scoped worker tools, and
 * the official answer-check prompts.
 *
 * Reference answers, evidence session ids and `has_answer` flags never reach
 * the plugin: sessions carry only role, text and time.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';

export const MODEL = { provider: 'deepseek', model: 'deepseek-flash' };
const API = 'https://api.deepseek.com/anthropic/v1/messages';
const SAMPLE_SALT = 'longmemeval-s-cleaned:cc-memory-0.25.0';

export function loadDataset(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The fixed 30-question diagnostic sample: 10 knowledge-update, 10
 * multi-session, 10 abstention (any type, id ends in `_abs`), each the first
 * ten by sha256(salt + ':' + question_id).
 */
export function sampleQuestions(dataset, perGroup = 10) {
  const rank = (q) => createHash('sha256').update(SAMPLE_SALT + ':' + q.question_id).digest('hex');
  const abs = (q) => q.question_id.endsWith('_abs');
  const groups = {
    'knowledge-update': dataset.filter((q) => !abs(q) && q.question_type === 'knowledge-update'),
    'multi-session': dataset.filter((q) => !abs(q) && q.question_type === 'multi-session'),
    abstention: dataset.filter(abs),
  };
  const picked = [];
  for (const [group, items] of Object.entries(groups)) {
    for (const q of items.sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, perGroup)) picked.push({ group, id: q.question_id });
  }
  return { rule: `per group, the first ${perGroup} question_ids by sha256("${SAMPLE_SALT}:" + question_id)`, picked };
}

/** "2023/05/20 (Sat) 02:21" -> epoch ms (UTC; only the order and spacing matter). */
export function parseDate(text) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+\(\w+\)\s+(\d{2}):(\d{2})/u.exec(String(text));
  if (!match) throw new Error('unparsable date: ' + text);
  const [, y, m, d, hh, mm] = match.map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
}

/** The question's history as host session records, oldest first, roles and text verbatim. */
export function sessionsOf(question, cwd) {
  return question.haystack_session_ids.map((sid, index) => {
    const createdAt = parseDate(question.haystack_dates[index]);
    const id = 'lme-' + sid;
    // The shapes DSH logs: a user message is the message itself, an assistant
    // message is wrapped with its turn and step.
    const events = question.haystack_sessions[index].map((turn, at) => {
      const content = [{ type: 'text', text: String(turn.content) }];
      return turn.role === 'assistant'
        ? { seq: at + 1, type: 'assistant/message', time: createdAt + at * 1000, data: { turn: 1, step: at + 1, message: { role: 'assistant', content } } }
        : { seq: at + 1, type: 'user/message', time: createdAt + at * 1000, data: { role: 'user', source: { kind: 'user' }, content } };
    });
    return { id, header: { id, cwd, createdAt, title: '' }, events };
  }).sort((a, b) => a.header.createdAt - b.header.createdAt || a.id.localeCompare(b.id));
}

const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 };
export const apiUsage = () => ({ ...usageTotals });

/** One Messages request with retries for transport failures, 429 and 5xx. */
export async function messages(body, { signal, attempts = 6 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(API, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': process.env.DEEPSEEK_API_KEY },
        body: JSON.stringify({ model: MODEL.model, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        usageTotals.requests += 1;
        usageTotals.inputTokens += Number(json.usage?.input_tokens) || 0;
        usageTotals.outputTokens += Number(json.usage?.output_tokens) || 0;
        usageTotals.cacheReadTokens += Number(json.usage?.cache_read_input_tokens) || 0;
        return json;
      }
      last = new Error(`HTTP ${res.status}: ${json.error?.message ?? ''}`);
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (error) {
      if (signal?.aborted) throw error;
      last = error;
      if (/^HTTP 4\d\d/u.test(String(error.message)) && !/^HTTP 429/u.test(String(error.message))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_500 * 2 ** attempt)));
  }
  throw last;
}

/** Plugin message list -> Messages API message list. */
function toApiMessages(list) {
  const out = [];
  const push = (role, blocks) => {
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of list) {
    if (message.role === 'tool') {
      const text = (message.content ?? []).map((block) => block.text ?? '').join('');
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: text || '(empty)' }]);
      continue;
    }
    const blocks = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text });
      else if (block.type === 'tool-call') {
        const input = typeof block.arguments === 'string' ? JSON.parse(block.arguments || '{}') : block.arguments ?? {};
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input });
      }
    }
    if (blocks.length > 0) push(message.role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  return out;
}

const apiTools = (tools) => tools.map(({ name, description, parameters }) => ({
  name, description: description ?? name, input_schema: parameters ?? { type: 'object', properties: {} },
}));

/** The plugin's `llm` service over the DeepSeek Messages API (one non-streamed response per turn). */
export const llmService = {
  stream(request) {
    return (async function* run() {
      const json = await messages({
        max_tokens: Math.min(Number(request.maxTokens) || 8_192, 32_000),
        ...(request.system ? { system: request.system } : {}),
        messages: toApiMessages(request.messages ?? []),
        ...(request.tools?.length ? { tools: apiTools(request.tools) } : {}),
      }, { signal: request.signal });
      for (const block of json.content ?? []) {
        if (block.type === 'text') yield { type: 'text-delta', text: block.text };
        else if (block.type === 'tool_use') yield { type: 'block-end', block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.input ?? {} } };
      }
      const input = (Number(json.usage?.input_tokens) || 0) + (Number(json.usage?.cache_read_input_tokens) || 0);
      const output = Number(json.usage?.output_tokens) || 0;
      yield { type: 'usage', usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: Number(json.usage?.cache_read_input_tokens) || 0 } };
      yield { type: 'finish', reason: { kind: json.stop_reason === 'tool_use' ? 'tool-calls' : json.stop_reason === 'max_tokens' ? 'length' : 'stop' } };
    })();
  },
};

const CHILD_SYSTEM = 'You are a delegated subagent working on a task from your parent. Use the tools you are given; operations outside them are not available.';

/**
 * A fake host whose Dream child is the same model driving the plugin's scoped
 * worker tools plus `structured_output`, the way the standard-preset child does
 * in DSH (without its persona prompt and its file tools).
 */
export function makeHost({ workspaceDir, sessions, onChildUsage }) {
  const listeners = new Map();
  const childUsage = new Map();
  const parent = { id: 'lme-parent', session: { header: { id: 'lme-parent', cwd: workspaceDir } } };
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const host = {
    parent,
    childStats: [],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    effect(factory) {
      const dispose = factory();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    get: (name) => host.services[name],
  };
  host.services = {
    workingDirectory: { ensure: async () => workspaceDir },
    tools: { register: () => () => {} },
    llm: llmService,
    agentDefaultModel: { currentSelection: () => ({ ...MODEL }) },
    agents: { get: (id) => (id === parent.id ? parent : undefined), list: () => [] },
    sessionQuery: {
      filterSessions: async (filters = []) => {
        const ids = filters.find((filter) => filter?.kind === 'id')?.values;
        return sessions.filter((session) => !ids || ids.includes(session.id)).map(({ header }) => ({ header: { ...header } }));
      },
      readSession: async (id) => {
        if (childUsage.has(id)) return { events: [{ seq: 0, type: 'assistant/message', data: { usage: childUsage.get(id) } }] };
        const session = byId.get(id);
        return session ? { session: { ...session.header }, events: structuredClone(session.events) } : undefined;
      },
      listEvents: async (id) => (byId.get(id)?.events ?? []).map(({ seq, type }) => ({ seq, type })),
    },
    subagents: {
      async startActivation(spec) {
        const definitions = new Map();
        host.emit('agent/created', {
          agent: {
            id: spec.childId,
            session: { append: () => {} },
            ctx: { tools: { restrict: () => () => {}, register: (definition) => {
              definitions.set(definition.name, definition);
              return () => definitions.delete(definition.name);
            } } },
          },
        });
        const result = playChild(spec, definitions, childUsage, host);
        return { childId: spec.childId, name: spec.name, result, dispose: async () => {} };
      },
    },
  };
  return host;
}

async function playChild(spec, definitions, childUsage, host) {
  const started = Date.now();
  const finish = { name: 'structured_output', description: 'Hand back your final result. Call it once, at the end.', parameters: spec.outputSchema };
  const list = [{ role: 'user', content: [{ type: 'text', text: spec.prompt.map((block) => block.text).join('\n') }] }];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
  let steps = 0;
  try {
    for (; steps < 300; steps += 1) {
      const tools = [...definitions.values(), finish];
      const json = await messages({ max_tokens: 16_000, system: CHILD_SYSTEM, messages: toApiMessages(list), tools: apiTools(tools) }, { signal: spec.signal });
      const input = (Number(json.usage?.input_tokens) || 0) + (Number(json.usage?.cache_read_input_tokens) || 0);
      usage.inputTokens += input;
      usage.outputTokens += Number(json.usage?.output_tokens) || 0;
      usage.cacheReadTokens += Number(json.usage?.cache_read_input_tokens) || 0;
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
      childUsage.set(spec.childId, { ...usage });
      const blocks = json.content ?? [];
      const calls = blocks.filter((block) => block.type === 'tool_use');
      list.push({ role: 'assistant', content: blocks.flatMap((block) => (block.type === 'text' ? [{ type: 'text', text: block.text }]
        : block.type === 'tool_use' ? [{ type: 'tool-call', id: block.id, name: block.name, arguments: block.input ?? {} }] : [])) });
      if (calls.length === 0) {
        list.push({ role: 'user', content: [{ type: 'text', text: 'Continue with the tools. Finish with structured_output.' }] });
        continue;
      }
      for (const call of calls) {
        if (call.name === 'structured_output') {
          host.childStats.push({ childId: spec.childId, steps: steps + 1, ms: Date.now() - started, usage: { ...usage } });
          return { stopReason: 'completed', output: [], structured: call.input };
        }
        const definition = definitions.get(call.name);
        let text;
        if (!definition) text = 'ERROR: unknown tool ' + call.name;
        else {
          const exec = { arguments: call.input, signal: spec.signal, id: call.id || randomUUID() };
          try {
            const value = await definition.execute(call.input ?? {}, exec);
            const content = definition.output.render(call.input, value);
            definition.finalizeContent?.(exec, { content, isError: false });
            text = content.map((block) => block.text ?? '').join('');
          } catch (error) {
            text = 'ERROR: ' + (error?.message ?? error);
          }
        }
        list.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text }] });
      }
    }
    return { stopReason: 'max-tokens', output: [] };
  } catch (error) {
    if (spec.signal?.aborted) return { stopReason: 'aborted', output: [] };
    host.childStats.push({ childId: spec.childId, steps, ms: Date.now() - started, usage: { ...usage }, error: String(error?.message ?? error) });
    return { stopReason: 'error', output: [], diagnostic: String(error?.message ?? error) };
  }
}

/** Verbatim from LongMemEval src/evaluation/evaluate_qa.py `get_anscheck_prompt`. */
export function anscheckPrompt(task, question, answer, response, abstention = false) {
  if (!abstention) {
    if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task)) {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'temporal-reasoning') {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'knowledge-update') {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'single-session-preference') {
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    throw new Error('unsupported question type ' + task);
  }
  return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
}

/** The official yes/no judgement, with DeepSeek as the judge model. */
export async function judge(reference, hypothesis) {
  const prompt = anscheckPrompt(reference.question_type, reference.question, reference.answer, hypothesis, reference.question_id.includes('_abs'));
  const json = await messages({ max_tokens: 2_000, temperature: 0, messages: [{ role: 'user', content: prompt }] });
  const text = (json.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
  return { label: text.toLowerCase().includes('yes'), raw: text };
}
