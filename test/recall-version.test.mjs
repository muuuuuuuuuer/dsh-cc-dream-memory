/**
 * Recall correctness: current-only selection, per-version dedupe and the hard
 * attachment character budget. These are the acceptance regressions for the
 * "recall the corrected version, not the outdated one" work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRecall, buildRecallText, attachRecall, recallKey, RECALL_SOURCE_KIND } from '../src/recall.js';
import { runtimeEnv } from './v10-helpers.mjs';

const files = (result) => result.map((item) => item.file);

/** A scoped context with the host's waterfall shape: handler(payload, next). */
function fakeAgentCtx() {
  const handlers = [];
  return {
    on(event, handler) {
      assert.equal(event, 'agent/pre-step');
      handlers.push(handler);
      return () => handlers.splice(handlers.indexOf(handler), 1);
    },
    async preStep(messages, base = { kind: 'enter', messages: [...messages] }) {
      const run = (index) => (index < handlers.length ? handlers[index]({ messages, signal: new AbortController().signal }, () => run(index + 1)) : Promise.resolve(base));
      return run(0);
    },
    count: () => handlers.length,
  };
}
const userMessage = (text) => ({ role: 'user', id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } });

/** Temp project with a real store and the recall hook attached. */
async function recallEnv(t, config = {}) {
  const env = await runtimeEnv(t, config);
  const agentCtx = fakeAgentCtx();
  const agent = { id: 'session-recall', ctx: agentCtx };
  env.runtime.forAgent = async () => env.pctx;
  const dispose = attachRecall({ agent, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  return { env, agentCtx, dispose };
}

// --- current-only selection -------------------------------------------------

test('current-only selection drops stale/superseded entries before ranking', () => {
  const entries = [
    { file: 'project_route_stale.md', scope: 'project', name: 'route registration', description: 'route registration kebab-case', type: 'project', modified: '2026-11-11T10:00:00.000Z', body: 'STATUS: superseded\nold rule' },
    { file: 'project_route_current.md', scope: 'project', name: 'route registration', description: 'route registration kebab-case', type: 'project', modified: '2026-11-11T10:00:00.000Z', body: 'STATUS: current\nnew rule' },
    { file: 'project_route_flagged.md', scope: 'project', name: 'route registration', description: 'route registration kebab-case', type: 'project', modified: '2026-11-11T10:00:00.000Z', current: false, body: 'no status marker at all' },
  ];
  assert.deepEqual(files(selectRecall({ query: 'route registration kebab-case', entries, maxFiles: 5 })), ['project_route_current.md']);
});

test('dedupe key is scope+file+version, not scope+file', () => {
  const entry = (scope, version, file = 'project_route_rules.md') => ({
    file, scope, name: 'route rules', description: 'route registration kebab-case', type: 'project', version,
  });
  const oldVersion = entry('project', 'h-old');
  const newVersion = entry('project', 'h-new');
  const shown = new Set([recallKey(oldVersion)]);
  assert.deepEqual(selectRecall({ query: 'route registration kebab-case', entries: [oldVersion], shown }), []);
  assert.deepEqual(files(selectRecall({ query: 'route registration kebab-case', entries: [newVersion], shown })), ['project_route_rules.md']);
  const userVersion = entry('user', 'h-old');
  assert.notEqual(recallKey(oldVersion), recallKey(userVersion));
  assert.deepEqual(
    selectRecall({ query: 'route registration kebab-case', entries: [oldVersion, userVersion], shown }).map((item) => item.scope),
    ['user'],
    'the same filename and version in another scope is a different memory',
  );
});

// --- stale metadata must not hide the body fallback -------------------------

test('a stale high-scoring title does not suppress the current body-search hit', async (t) => {
  const { env, agentCtx } = await recallEnv(t);
  await env.pctx.store.saveEntry({
    name: 'Route registration',
    type: 'project',
    description: 'route registration kebab-case API routes',
    content: 'STATUS: superseded\nOld rule: register routes in camelCase.',
  });
  await env.pctx.store.saveEntry({
    name: 'Zone notes',
    type: 'project',
    description: 'miscellaneous platform detail',
    content: 'STATUS: current\nRoute registration must stay kebab-case; verified on the real entry point.',
  });
  const searches = [];
  const originalSearch = env.pctx.store.search.bind(env.pctx.store);
  env.pctx.store.search = (query, options) => {
    searches.push({ query, ...options });
    return originalSearch(query, options);
  };
  const message = userMessage('route registration kebab-case');
  const decision = await agentCtx.preStep([message]);
  assert.equal(decision.messages.length, 2);
  const text = decision.messages[1].content[0].text;
  assert.match(text, /must stay kebab-case/);
  assert.doesNotMatch(text, /Old rule/);
  assert.equal(searches.length, 1, 'the body fallback ran once after metadata produced only non-current pages');
  assert.equal(searches[0].scope, 'project');
  assert.equal(searches[0].query, 'route registration kebab-case');
  assert.equal((await agentCtx.preStep([message])).messages.length, 1, 'the body fallback version is deduped too');
});

test('a stale high-scorer does not take the only slot from a current page', async (t) => {
  const { env, agentCtx } = await recallEnv(t, { autoRecallMaxFiles: 1 });
  const query = 'deploy target legacy platform';
  const stale = await env.pctx.store.saveEntry({
    name: 'Deploy target legacy',
    type: 'project',
    description: 'deployment target legacy platform',
    content: 'STATUS: superseded\nLegacy target: AWS Lambda.',
  });
  await env.pctx.store.saveEntry({
    name: 'Deploy target current',
    type: 'project',
    description: 'deployment target current platform',
    content: 'STATUS: current\nCurrent target: GCP Cloud Run.',
  });
  // The stale metadata page really does rank first; it must simply be skipped.
  const listed = (await env.pctx.store.listEntries('project')).map((entry) => ({ ...entry, scope: 'project' }));
  assert.equal(selectRecall({ query, entries: listed, maxFiles: 1 })[0].file, stale.file);
  const decision = await agentCtx.preStep([userMessage(query)]);
  assert.equal(decision.messages.length, 2);
  const text = decision.messages[1].content[0].text;
  assert.match(text, /GCP Cloud Run/);
  assert.doesNotMatch(text, /AWS Lambda/);
});

// --- corrected same-file version ------------------------------------------

test('a corrected file version is recallable in the same session; the old version is not repeated', async (t) => {
  const { env, agentCtx } = await recallEnv(t);
  const first = await env.pctx.store.saveEntry({
    name: 'Deploy target',
    type: 'project',
    description: 'deployment target platform',
    content: 'STATUS: current\nDeployment target is AWS Lambda.',
  });
  const message = userMessage('deployment target platform');
  const step1 = await agentCtx.preStep([message]);
  assert.equal(step1.messages.length, 2);
  assert.match(step1.messages[1].content[0].text, /AWS Lambda/);

  const second = await env.pctx.store.saveEntry({
    name: 'Deploy target',
    type: 'project',
    description: 'deployment target platform',
    content: 'STATUS: current\nDeployment target moved to GCP Cloud Run.',
  });
  assert.equal(second.created, false, 'the correction updates the same file');
  assert.equal(second.file, first.file);

  const step2 = await agentCtx.preStep([message]);
  assert.equal(step2.messages.length, 2, 'the corrected version is recalled again');
  const corrected = step2.messages[1].content[0].text;
  assert.match(corrected, /GCP Cloud Run/);
  assert.doesNotMatch(corrected, /AWS Lambda/, 'the old version is not repeated');
  assert.equal((await agentCtx.preStep([message])).messages.length, 1, 'the corrected version is deduped afterwards');
});

// --- note priority and the hard character budget ---------------------------

test('a tight budget keeps APPLIES WHEN/VERIFY/OBSERVED/EXCEPTION and trims raw body', () => {
  const body = [
    'STATUS: current',
    `RAW-START ${'detail '.repeat(300)}RAW-END`,
    'APPLIES WHEN: registering a route',
    'HOW TO VERIFY: call the real entry point',
    'OBSERVED: a handler test passed but the real route returned 404',
    'EXCEPTION: a trailing slash is legal',
  ].join('\n');
  const attached = [];
  const text = buildRecallText(
    [{ file: 'project_route_rules.md', scope: 'project', modified: '2026-11-11T10:00:00.000Z', body }],
    { maxChars: 600, attached },
  );
  assert.ok(text.length <= 600, `attached text is ${text.length} characters, cap is 600`);
  assert.equal(attached.length, 1);
  assert.match(text, /Applies when: registering a route/i);
  assert.match(text, /Verify: call the real entry point/i);
  assert.match(text, /Observed: a handler test passed/i);
  assert.match(text, /Exception: a trailing slash is legal/i);
  assert.match(text, /RAW-START/);
  assert.doesNotMatch(text, /RAW-END/, 'raw body is trimmed before any caveat line');
});

test('the attached message text never exceeds autoRecallMaxChars', async (t) => {
  const { env, agentCtx } = await recallEnv(t, { autoRecallMaxChars: 700 });
  for (const suffix of ['alpha', 'beta']) {
    await env.pctx.store.saveEntry({
      name: `Deploy runbook ${suffix}`,
      type: 'project',
      description: `cloud run deploy runbook ${suffix}`,
      content: ['STATUS: current', 'runbook step detail '.repeat(300), `APPLIES WHEN: deploying ${suffix}`, `EXCEPTION: ${suffix} may skip`].join('\n'),
    });
  }
  const searches = [];
  const originalSearch = env.pctx.store.search.bind(env.pctx.store);
  env.pctx.store.search = (query, options) => {
    searches.push(query);
    return originalSearch(query, options);
  };
  const message = userMessage('cloud run deploy runbook');
  const decision = await agentCtx.preStep([message]);
  assert.equal(decision.messages.length, 2);
  const text = decision.messages[1].content[0].text;
  assert.ok(text.length <= 700, `attached text is ${text.length} characters, cap is 700`);
  assert.match(text, /project_deploy_runbook_alpha\.md/);
  assert.match(text, /project_deploy_runbook_beta\.md/);
  assert.match(text, /Applies when: deploying alpha/);
  assert.match(text, /Applies when: deploying beta/);
  assert.equal(searches.length, 0, 'body fallback is not used when current metadata already matched');
  assert.equal((await agentCtx.preStep([message])).messages.length, 1);
});

test('an exception caveat survives a very small configured budget', async (t) => {
  const { env, agentCtx } = await recallEnv(t, { autoRecallMaxChars: 500, autoRecallMaxFiles: 1 });
  await env.pctx.store.saveEntry({
    name: 'Route registration',
    type: 'project',
    description: 'route registration kebab-case',
    content: [
      'STATUS: current',
      'route registration detail '.repeat(300),
      'APPLIES WHEN: adding an API route',
      'HOW TO VERIFY: hit the real entry point',
      'EXCEPTION: a trailing slash is legal',
    ].join('\n'),
  });
  const decision = await agentCtx.preStep([userMessage('route registration kebab-case')]);
  assert.equal(decision.messages.length, 2);
  const text = decision.messages[1].content[0].text;
  assert.ok(text.length <= 500, `attached text is ${text.length} characters, cap is 500`);
  assert.match(text, /Applies when: adding an API route/);
  assert.match(text, /Verify: hit the real entry point/);
  assert.match(text, /Exception: a trailing slash is legal/);
});
