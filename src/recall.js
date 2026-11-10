/**
 * Automatic recall.
 *
 * The index tells the model what exists, but a model busy with a task rarely
 * stops to search. When a typed user message clearly matches a memory's name and
 * description, the memory's body is attached to that step as background context.
 *
 * Matching is lexical on purpose: it runs on every user turn, costs no model
 * call, and stays strict because a wrong memory in context is worse than none.
 * It only reads names and descriptions, the same surface the index shows.
 *
 * The attachment is its own message added through the host's `agent/pre-step`
 * waterfall rather than part of the runtime-context snapshot, because any change
 * to that snapshot makes the host re-send all of it.
 */
import { randomUUID } from 'node:crypto';
import { recordRecall } from './metrics.js';

/** `source.kind` of attached memories; Dream ignores it like any injected context. */
export const RECALL_SOURCE_KIND = 'plugin:cc-memory-recall';

const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_CHARS = 3_000;
/** Independent shared terms needed unless a non-profile has one strong match. */
const MIN_MATCHES = 2;
/** A profile note matches everything loosely, so it must match more strictly. */
const MIN_MATCHES_PROFILE = 3;
/** A long message shares a few terms with anything, so it must also cover the memory. */
const LONG_QUERY_CHARS = 400;
const LONG_QUERY_MIN_COVERAGE = 0.4;

const LATIN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'are', 'was', 'were', 'will', 'would', 'should',
  'can', 'could', 'not', 'you', 'your', 'our', 'what', 'when', 'where', 'why', 'how', 'who', 'which', 'please', 'help',
  'use', 'used', 'using', 'add', 'make', 'get', 'set', 'new', 'all', 'any', 'some', 'hello', 'world', 'project', 'memory',
  'note', 'notes', 'file', 'files', 'user',
]);
const CJK_STOP_BIGRAMS = new Set([
  '这个', '那个', '一下', '一个', '什么', '怎么', '怎样', '可以', '我们', '你们', '帮我', '需要', '没有', '现在', '如果', '因为',
  '所以', '还是', '不要', '就是', '这些', '那些', '已经', '然后', '项目', '记忆', '用户', '以后', '一律', '时候', '问题', '东西',
]);
/** Generic title labels cannot make a one-word match strong by themselves. */
const WEAK_NAME_TERMS = new Set([
  'process', 'format', 'guide', 'style', 'rules', 'settings', 'config', 'configuration', 'system', 'service', 'database',
  '数据', '数据库', '文档', '平台', '系统', '服务', '格式', '规范', '规则', '说明', '流程', '环境', '设置', '配置', '风格', '偏好',
]);
const cjkWords = new Intl.Segmenter('zh', { granularity: 'word' });
const cjkRuns = (text) => String(text ?? '').match(/[㐀-鿿]{2,}/g) ?? [];
const recallKey = (entry) => entry.scope ? `${entry.scope}:${entry.file}` : entry.file;

/** Only whole dictionary words, not arbitrary cross-word name bigrams. */
function cjkNameWords(text) {
  return new Set([...cjkWords.segment(String(text ?? ''))]
    .map(({ segment }) => segment)
    .filter((word) => /^[㐀-鿿]{2,}$/.test(word) && !CJK_STOP_BIGRAMS.has(word) && !WEAK_NAME_TERMS.has(word)));
}

/**
 * Adjacent overlapping bigrams describe one shared segment, not independent
 * evidence. Merge in either text so even repeated or separated query fragments
 * cannot count a single continuous metadata segment twice.
 */
function independentMatches(matched, runs) {
  const groups = new Map(matched.map((token) => [token, new Set([token])]));
  for (const run of runs) {
    for (let index = 0; index + 3 <= run.length; index += 1) {
      const left = groups.get(run.slice(index, index + 2));
      const right = groups.get(run.slice(index + 1, index + 3));
      if (!left || !right || left === right) continue;
      for (const token of right) {
        left.add(token);
        groups.set(token, left);
      }
    }
  }
  return [...new Set(groups.values())];
}

/** Four consecutive shared Han characters are one strong contextual phrase. */
function hasSharedPhrase(queryRuns, memoryRuns) {
  for (const run of memoryRuns) {
    for (let index = 0; index + 4 <= run.length; index += 1) {
      const phrase = run.slice(index, index + 4);
      if (queryRuns.some((query) => query.includes(phrase)) && cjkNameWords(phrase).size > 0) return true;
    }
  }
  return false;
}

/** Terms of one text: latin words and CJK bigrams, minus words that say nothing. */
export function tokenize(text) {
  const tokens = new Set();
  const value = String(text ?? '').toLowerCase();
  for (const word of value.match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (!LATIN_STOP_WORDS.has(word)) tokens.add(word);
  }
  for (const run of value.match(/[㐀-鿿]{2,}/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!CJK_STOP_BIGRAMS.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

/**
 * Pick the memories a message is clearly about.
 * @param {{query:string, entries:Array<{file:string,scope?:'project'|'user',name?:string,description?:string,type?:string}>, shown?:Set<string>, maxFiles?:number}} input
 * @returns {object[]} matching entries, best first.
 */
export function selectRecall({ query, entries, shown = new Set(), maxFiles = DEFAULT_MAX_FILES }) {
  const wanted = tokenize(query);
  if (wanted.size === 0 || !Array.isArray(entries)) return [];
  const queryRuns = cjkRuns(query);
  const queryWords = cjkNameWords(query);
  const indexed = entries.map((entry) => {
    const text = `${entry.name ?? ''} ${entry.description ?? ''}`;
    return { entry, tokens: tokenize(text), runs: cjkRuns(text) };
  });
  const documentFrequency = new Map();
  for (const { tokens } of indexed) {
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const scored = [];
  for (const { entry, tokens, runs } of indexed) {
    if (shown.has(recallKey(entry)) || tokens.size === 0) continue;
    const matched = [...tokens].filter((token) => wanted.has(token));
    if (matched.length === 0) continue;
    const groups = independentMatches(matched, [...queryRuns, ...runs]);
    const needed = entry.type === 'user' ? MIN_MATCHES_PROFILE : MIN_MATCHES;
    const strongName = [...tokenize(entry.name)].some((token) => /^[a-z]{5,}$/.test(token) && !WEAK_NAME_TERMS.has(token) && wanted.has(token))
      || [...cjkNameWords(entry.name)].some((word) => queryWords.has(word));
    const strong = entry.type !== 'user' && (strongName || hasSharedPhrase(queryRuns, runs));
    if (groups.length < needed && !strong) continue;
    const coverage = matched.length / tokens.size;
    if (String(query).length > LONG_QUERY_CHARS && coverage < LONG_QUERY_MIN_COVERAGE) continue;
    // Score each independent group once; rare terms say more than common ones.
    const score = groups.reduce((sum, group) => sum + Math.max(...[...group].map((token) => 1 + Math.log(indexed.length / documentFrequency.get(token)))), 0);
    scored.push({ entry, score, coverage });
  }
  scored.sort((left, right) => right.score - left.score || right.coverage - left.coverage || left.entry.file.localeCompare(right.entry.file));
  return scored.slice(0, maxFiles).map((item) => item.entry);
}

/** The attached text: bounded, dated, and explicit that it is only background. */
export function buildRecallText(items, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const present = items.filter((item) => typeof item?.body === 'string' && item.body.trim() !== '');
  if (present.length === 0) return '';
  const share = Math.floor(maxChars / present.length);
  const sections = present.map((item) => {
    const updated = typeof item.modified === 'string' ? item.modified.slice(0, 10) : '';
    const body = item.body.trim();
    const clipped = body.length <= share ? body : `${body.slice(0, share)}…(use memory_read for the rest)`;
    return `## ${item.scope ? `${item.scope}/` : ''}${item.file}${updated ? ` (updated ${updated})` : ''}\n${clipped}`;
  });
  return [
    '<system-reminder>',
    'Memories from earlier sessions that may relate to this message. They are background context and may be stale: verify before relying on them, and current instructions win.',
    '',
    sections.join('\n\n'),
    '</system-reminder>',
  ].join('\n');
}

/** The text of what the user typed this step; injected context does not count. */
function typedUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    const kind = message?.source?.kind;
    if (message?.role !== 'user' || (kind !== undefined && kind !== 'user')) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Hook recall into one agent's steps.
 * @param {{agent:object, agentCtx:object, runtime:object, config:()=>object, shown?:Set<string>}} params
 * @returns {() => void} disposer.
 */
export function attachRecall({ agent, agentCtx, runtime, config, shown = new Set() }) {
  const stop = agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      const effective = config();
      if (effective?.enabled === false || effective?.autoMemoryEnabled === false || effective?.autoRecall === false) return decision;
      const query = typedUserText(payload?.messages);
      if (query === '') return decision;
      const project = await runtime.forAgent(agent);
      if (!project?.store) return decision;
      const entries = (await project.store.listEntries('project')).map((entry) => ({ ...entry, scope: 'project' }));
      if (effective.userMemoryEnabled === true) {
        entries.push(...(await project.store.listEntries('user')).map((entry) => ({ ...entry, scope: 'user' })));
      }
      const selected = selectRecall({
        query,
        entries,
        shown,
        maxFiles: Number(effective?.autoRecallMaxFiles) || DEFAULT_MAX_FILES,
      });
      if (selected.length === 0) return decision;
      const items = [];
      for (const entry of selected) {
        const read = await project.store.readEntry(entry.file, entry.scope);
        items.push({ file: entry.file, scope: entry.scope, modified: entry.modified, body: read?.body });
      }
      const text = buildRecallText(items, { maxChars: Number(effective?.autoRecallMaxChars) || DEFAULT_MAX_CHARS });
      if (text === '') return decision;
      for (const entry of selected) shown.add(recallKey(entry));
      runtime.track?.(recordRecall(project.paths, selected.length));
      return {
        ...decision,
        messages: [
          ...decision.messages,
          { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: RECALL_SOURCE_KIND } },
        ],
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[cc-memory] recall:', error?.message ?? error);
      return decision;
    }
  });
  return typeof stop === 'function' ? stop : () => {};
}
