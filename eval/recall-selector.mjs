/**
 * Live check of the recall selector alone: unrelated messages should select
 * nothing, related ones should keep their target note. Needs DEEPSEEK_API_KEY.
 *   node eval/recall-selector.mjs [runs]
 */
import { selectRecallByModel } from '../src/recall.js';

const entries = [
  { file: 'user_style.md', type: 'user', description: 'User prefers concise answers in Chinese, no long preambles', body: 'Keep answers short.' },
  { file: 'project_overview.md', type: 'project', description: 'dsh-cc-memory: DSH plugin for auto memory and Dream; Node 22, no deps', body: 'Plugin for DeepSeek Harness.' },
  { file: 'project_release.md', type: 'project', description: 'Release: default pnpm release; staging still uses npm release', body: 'Run pnpm release.\nApplies when: production.\nRun npm release.\nApplies when: staging.' },
  { file: 'project_codename.md', type: 'project', description: 'Internal codename Aurora; never write it in README or public docs', body: 'Codename Aurora. Do not put it in README.' },
  { file: 'feedback_tests.md', type: 'feedback', description: 'Run node --test before claiming a fix; do not skip failing tests', body: 'Always run tests.' },
  { file: 'reference_ci.md', type: 'reference', description: 'CI dashboard lives at GitHub Actions, windows-latest runner flaky on fs.rename', body: 'fs.rename EPERM on Windows runner; retry.' },
];
// `want`: must be selected. `ok`: tolerated extras. Anything else is a misinjection.
const cases = [
  { id: 'unrelated-css', query: 'Change the badge color in the composer dock to match the theme', want: [], ok: [] },
  { id: 'unrelated-regex', query: 'Write a regex that matches ISO dates', want: [], ok: [] },
  { id: 'unrelated-typo', query: 'Fix the typo "recieve" in src/inbox.js comments', want: [], ok: ['feedback_tests.md'] },
  { id: 'unrelated-helper', query: 'What does the lock.js withFileLock helper do?', want: [], ok: [] },
  { id: 'release-staging', query: 'Ship this version to staging', want: ['project_release.md'], ok: ['feedback_tests.md'] },
  { id: 'public-readme', query: 'Update the public README intro paragraph to describe the project', want: ['project_codename.md'], ok: ['project_overview.md'] },
  { id: 'ci-eperm', query: 'The Windows CI job failed with EPERM during rename, what now?', want: ['reference_ci.md'], ok: ['feedback_tests.md'] },
];

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required');
const llm = { stream: async function* (options) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', signal: options.signal,
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0, max_tokens: options.maxTokens,
      messages: [{ role: 'system', content: options.system }, { role: 'user', content: options.messages[0].content[0].text }] }),
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const result = await response.json();
  yield { type: 'text-delta', text: result.choices[0]?.message?.content ?? '' };
  yield { type: 'finish', reason: { kind: 'stop' } };
} };
const ctx = { get: (key) => key === 'llm' ? llm : { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } };

const runs = Number(process.argv[2]) || 2;
let missed = 0;
let injected = 0;
for (let run = 1; run <= runs; run++) {
  for (const { id, query, want, ok } of cases) {
    const result = await selectRecallByModel({ ctx, config: { recallTimeoutMs: 15_000 }, query, entries, maxFiles: 3 });
    const extra = result.files.filter((file) => !want.includes(file) && !ok.includes(file));
    const absent = want.filter((file) => !result.files.includes(file));
    missed += absent.length;
    injected += extra.length;
    console.log(JSON.stringify({ run, case: id, status: result.status, files: result.files, missing: absent, misinjected: extra }));
  }
}
console.log(JSON.stringify({ runs, missedTargets: missed, misinjectedFiles: injected }));
