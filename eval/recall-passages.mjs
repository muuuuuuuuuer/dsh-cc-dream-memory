/** Recall attachment probe against 0.21.0. Set --live to call DeepSeek Flash. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachRecall, RECALL_SOURCE_KIND } from '../src/recall.js';
import { stringifyFrontmatter } from '../src/frontmatter.js';
import { makeEnv } from '../test/v10-helpers.mjs';

const BASELINE = 'abcd82cce166e7d7f2396d5a5e52e68ba446b208';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const live = process.argv.includes('--live');
const repeats = live ? 2 : 1;
const background = 'Administrative background unrelated to the recovery procedure. '.repeat(80);
const cases = [
  { id: 'tail', file: 'project_tail.md', query: 'What command fixes EALIAS in staging?', answer: 'relay-verify-v73',
    body: `## Background\n${background}\n\n## Staging\nRun relay-verify-v73 for EALIAS.\nApplies when: staging.`,
    evidence: /relay-verify-v73[\s\S]*Applies when: staging/ },
  { id: 'same-page-conditions', file: 'project_route.md', query: 'What command fixes ROUTEFIX in Windows staging?', answer: 'relay-route-v65',
    body: `## Linux production\nRun relay-route-v18 for ROUTEFIX.\nApplies when: Linux production.\n\n${background}\n\n## Windows staging\nRun relay-route-v65 for ROUTEFIX.\nApplies when: Windows staging.`,
    evidence: /relay-route-v65[\s\S]*Applies when: Windows staging/, excluded: 'relay-route-v18' },
  { id: 'short-source-order', file: 'project_bridge.md', query: 'Which command fixes BRIDGEBREAK on an isolated circuit?', answer: 'bridge-sync-v41',
    body: '## First method\nRun bridge-sync-v41 for BRIDGEBREAK.\nApplies when: isolated circuit.\n\n## Second method\nRun bridge-sync-v92 for BRIDGEBREAK.\nApplies when: shared circuit.',
    evidence: /bridge-sync-v41[^\n]*\nApplies when: isolated circuit\.[\s\S]*bridge-sync-v92[^\n]*\nApplies when: shared circuit/ },
  { id: 'tight-exception', file: 'project_probe.md', query: 'What command fixes DEEPCHECK on a shared resolver?', answer: 'UNKNOWN', maxChars: 430,
    body: `Run probe-normalize-v22 for DEEPCHECK.\nException: ${'Never use this for a shared resolver. '.repeat(16)}`,
    evidence: /use memory_read for the rest/, excluded: 'probe-normalize-v22' },
  { id: 'short-control', file: 'project_mirror.md', query: 'Which command handles MIRRORFLAG?', answer: 'mirror-verify-v88',
    body: 'Use mirror-verify-v88 for MIRRORFLAG.', evidence: /mirror-verify-v88/ },
  { id: 'paraphrase', file: 'project_cache.md', query: 'CI builds hang waiting on a lock in the cache layer. What do I run?', answer: 'cache-purge-v57',
    body: 'Run cache-purge-v57 to clear the CACHEJAM build lock.\nApplies when: CI runners.', evidence: /cache-purge-v57/ },
  { id: 'no-match', query: 'What command fixes ZZZQX9?', answer: 'UNKNOWN' },
  { id: 'near-miss', query: 'What command fixes RELAYDROP in staging?', answer: 'UNKNOWN' },
];

function baselineUrl(file, overrides = {}) {
  const source = execFileSync('git', ['show', `${BASELINE}:src/${file}`], { cwd: ROOT, encoding: 'utf8' });
  const linked = source.replace(/from '(\.\/[^']+)'/g, (_match, relative) =>
    `from '${overrides[relative] ?? pathToFileURL(path.join(ROOT, 'src', relative)).href}'`);
  return `data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`;
}

async function complete(messages, maxTokens, signal) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0, max_tokens: maxTokens, messages }),
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const result = await response.json();
  return { text: result.choices[0]?.message?.content ?? '', tokens: result.usage?.total_tokens };
}

async function runOne(variant, fixture, env, repeat) {
  let hook;
  let offered = '';
  let selectorTokens;
  let selectorError;
  let selectorCalls = 0;
  const llm = { stream: async function* (options) {
    selectorCalls++;
    offered = options.messages[0].content[0].text;
    try {
      const result = live ? await complete([{ role: 'system', content: options.system }, { role: 'user', content: offered }], options.maxTokens, options.signal)
        : { text: JSON.stringify({ selected_memories: fixture.file && offered.includes(fixture.file) ? [fixture.file] : [] }) };
      selectorTokens = result.tokens;
      yield { type: 'text-delta', text: result.text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } catch (error) {
      selectorError = error.cause?.code ?? error.message;
      throw error;
    }
  } };
  const ctx = { get: (key) => key === 'llm' ? llm : { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } };
  variant.attach({
    agent: {}, agentCtx: { on: (_event, handler) => { hook = handler; } },
    runtime: { ctx, forAgent: async () => ({ paths: env.paths, store: variant.store }) },
    config: () => ({ ...env.config, autoRecallMaxChars: fixture.maxChars ?? 620 }),
  });
  const query = `${fixture.query} Return the exact command or UNKNOWN.`;
  const messages = [{ id: 'query', role: 'user', content: [{ type: 'text', text: query }] }];
  const start = performance.now();
  const decision = await hook({ messages }, async () => ({ kind: 'enter', messages }));
  const recallMs = Math.round(performance.now() - start);
  if (selectorError) throw new Error(`${variant.name}/${fixture.id} selector: ${selectorError}`);
  const attached = decision.messages.find(({ source }) => source?.kind === RECALL_SOURCE_KIND)?.content[0].text ?? '';
  const attachedFiles = [...attached.matchAll(/^## project\/([^\s]+\.md)/gmu)].map((match) => match[1]);
  const answer = live ? await complete([
    { role: 'system', content: 'Answer the fictional project question from applicable attached memories. Return one exact command or UNKNOWN if the context does not support a command.' },
    ...decision.messages.map(({ role, content }) => ({ role, content: content[0].text })),
  ], 80, AbortSignal.timeout(15000)) : null;
  return { repeat, version: variant.name, case: fixture.id, selectorCalls, recallMs, selectorTokens,
    candidate: fixture.file ? offered.includes(fixture.file) : null,
    attached: fixture.file ? attached.includes(fixture.file) : attached !== '',
    expectedAttachment: fixture.file ? fixture.evidence.test(attached) && !(fixture.excluded && attached.includes(fixture.excluded)) : attached === '',
    attachedFiles, attachmentChars: attached.length, answerTokens: answer?.tokens,
    exactAnswer: answer ? answer.text.trim().replace(/^`|`$/gu, '') === fixture.answer : null };
}

if (live && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for --live');
const cleanup = [];
const env = await makeEnv({ after: (fn) => cleanup.push(fn) }, { recallMode: 'model', recallTimeoutMs: 12_000 });
try {
  for (const fixture of cases.filter(({ file }) => file)) {
    await fs.writeFile(path.join(env.paths.memoryDir, fixture.file), stringifyFrontmatter({
      name: fixture.id, type: 'project', description: 'Recovery reference', modified: '2025-01-01',
    }, fixture.body));
  }
  const [{ attachRecall: attach }, { MemoryStore }] = await Promise.all([
    import(baselineUrl('recall.js', { './llm-call.js': baselineUrl('llm-call.js') })),
    import(baselineUrl('store.js')),
  ]);
  const variants = [
    { name: '0.21.0', attach, store: new MemoryStore({ paths: env.paths, getConfig: () => env.config }) },
    { name: version, attach: attachRecall, store: env.store },
  ];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [index, fixture] of cases.entries()) {
      const order = (index + repeat) % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of order) console.log(JSON.stringify(await runOne(variant, fixture, env, repeat + 1)));
    }
  }
} finally {
  for (const fn of cleanup) await fn();
}
