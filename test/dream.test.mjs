/**
 * Tests for src/dream.js pure helpers (dream-engine).
 *
 * Contract: INTERFACES.md "src/dream.js" — JSON plan extraction from LLM text and
 * validateDreamPlan(plan, { config, existingFiles }) returning
 * { ok, plan: normalized, dropped: string[] }.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers.mjs';

let configModulePromise;

/** Load and validate the two exported pure helpers (names may drift; report it). */
async function dreamHelpers() {
  const mod = await loadModule('../src/dream.js');
  const missing = [];
  if (typeof mod.validateDreamPlan !== 'function') missing.push('validateDreamPlan');
  const extractCandidates = ['extractJsonPlan', 'extractJSONPlan', 'extractPlan', 'extractJson', 'parseDreamPlan', 'parsePlan'];
  const extractName = extractCandidates.find((name) => typeof mod[name] === 'function');
  if (!extractName) missing.push(`extractJsonPlan (tried ${extractCandidates.join(', ')})`);
  if (missing.length > 0) {
    throw new Error(
      `[missing-export] src/dream.js is missing: ${missing.join('; ')}. Actual exports: ${Object.keys(mod).join(', ') || '(none)'}`,
    );
  }
  return { mod, extractJsonPlan: mod[extractName], extractName, validateDreamPlan: mod.validateDreamPlan };
}

async function config(raw = {}) {
  if (!configModulePromise) {
    configModulePromise = loadModule('../src/config.js', { requireExports: ['resolveConfig'] });
  }
  const { resolveConfig } = await configModulePromise;
  return resolveConfig(raw);
}

/** Accept either an object return or a JSON string return from the extractor. */
function asPlan(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

/**
 * Bad input may either throw or return a "not ok" marker; both are acceptable
 * failure signalling. When it throws, the message must say what went wrong.
 */
function assertExtractionFails(extractJsonPlan, text, what) {
  let outcome;
  try {
    outcome = extractJsonPlan(text);
  } catch (error) {
    assert.ok(error, `${what}: expected an error`);
    assert.match(String(error.message ?? error), /json|parse|plan|found|invalid/i, `${what}: unhelpful error message`);
    return;
  }
  assert.equal(
    outcome === null || outcome === undefined || (typeof outcome === 'object' && outcome.ok === false) || outcome === '',
    true,
    `${what}: extractor returned a plan for unusable text: ${JSON.stringify(outcome)}`,
  );
}

function retainedOps(result) {
  if (!result || result.ok === false) return [];
  const operations = result.plan && Array.isArray(result.plan.operations) ? result.plan.operations : [];
  return operations;
}

test('extractJsonPlan parses a ```json fenced code block', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  const text = [
    'Here is the consolidation plan:',
    '```json',
    '{"summary":"merged duplicates","operations":[{"op":"index","content":"- [a](a.md) — x"}]}',
    '```',
    'Done.',
  ].join('\n');
  const plan = asPlan(extractJsonPlan(text));
  assert.equal(plan.summary, 'merged duplicates');
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].op, 'index');
});

test('extractJsonPlan parses a bare JSON object embedded in prose', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  const text = 'Sure. {"summary":"bare plan","operations":[]} That is all.';
  const plan = asPlan(extractJsonPlan(text));
  assert.equal(plan.summary, 'bare plan');
  assert.deepEqual(plan.operations, []);
});

test('extractJsonPlan handles nested braces and quoted braces', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  const text = [
    'plan:',
    '{"summary":"nested","operations":[{"op":"index","content":"- [a](a.md) — {\\"json\\":\\"inside\\"}"}],"notes":"{}"}',
    'end',
  ].join('\n');
  const plan = asPlan(extractJsonPlan(text));
  assert.equal(plan.summary, 'nested');
  assert.match(plan.operations[0].content, /\{"json":"inside"\}/);
  assert.equal(plan.notes, '{}');
});

test('extractJsonPlan prefers the first ```json block over earlier prose braces', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  const text = [
    'Use {braces} carefully.',
    '```json',
    '{"summary":"from the code block","operations":[]}',
    '```',
    '```json',
    '{"summary":"second block","operations":[]}',
    '```',
  ].join('\n');
  const plan = asPlan(extractJsonPlan(text));
  assert.equal(plan.summary, 'from the code block');
});

test('extractJsonPlan rejects malformed JSON with a clear error', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  assertExtractionFails(extractJsonPlan, '```json\n{"summary": oops, "operations":[]}\n```', 'malformed JSON');
});

test('extractJsonPlan rejects text without any JSON object', async () => {
  const { extractJsonPlan } = await dreamHelpers();
  assertExtractionFails(extractJsonPlan, 'I could not produce a plan this time.', 'text without JSON');
});

const VALID_WRITE = {
  op: 'write',
  scope: 'project',
  type: 'user',
  name: 'user_role',
  description: 'Who the user is',
  body: 'Prefers TypeScript.',
};
const VALID_INDEX = {
  op: 'index',
  scope: 'project',
  content: '- [user_role](user_role.md) — Who the user is',
};

test('validateDreamPlan accepts a valid plan', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config();
  const result = validateDreamPlan(
    { summary: 'merge duplicates', operations: [VALID_WRITE, VALID_INDEX], notes: 'nothing else' },
    { config: cfg, existingFiles: [] },
  );
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.dropped), 'dropped must be an array');
  assert.deepEqual(result.dropped, []);
  assert.ok(result.plan && Array.isArray(result.plan.operations));
  assert.equal(result.plan.operations.length, 2);
  assert.equal(result.plan.summary, 'merge duplicates');
});

test('validateDreamPlan drops operations with escaping paths', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ dreamAllowDelete: true });
  const result = validateDreamPlan(
    {
      summary: 'bad paths',
      operations: [
        { op: 'delete', scope: 'project', file: '../evil.md', reason: 'escape' },
        { op: 'delete', scope: 'project', file: 'sub/evil.md', reason: 'nested' },
        VALID_WRITE,
      ],
    },
    { config: cfg, existingFiles: ['evil.md'] },
  );
  const kept = retainedOps(result);
  assert.equal(
    kept.some((operation) => operation.op === 'delete'),
    false,
    'delete operations escaping the memory dir must be dropped',
  );
  assert.ok(kept.some((operation) => operation.op === 'write'), 'valid write op must be retained');
  assert.ok(result.dropped.length >= 2, `expected >= 2 dropped operations, got ${result.dropped.length}`);
  assert.ok(result.dropped.every((entry) => typeof entry === 'string'), 'dropped entries must be strings');
});

test('validateDreamPlan refuses deletes when dreamAllowDelete is false', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ dreamAllowDelete: false });
  const result = validateDreamPlan(
    {
      summary: 'delete attempt',
      operations: [{ op: 'delete', scope: 'project', file: 'old.md', reason: 'stale' }, VALID_WRITE],
    },
    { config: cfg, existingFiles: ['old.md'] },
  );
  const kept = retainedOps(result);
  assert.equal(kept.some((operation) => operation.op === 'delete'), false, 'delete must be dropped when disabled');
  assert.ok(result.dropped.length >= 1, 'dropped delete must be reported');
  assert.match(result.dropped.join(' '), /old\.md|delete|disabled|not allowed/i);
});

test('validateDreamPlan keeps deletes when dreamAllowDelete is true', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ dreamAllowDelete: true });
  const result = validateDreamPlan(
    {
      summary: 'prune stale',
      operations: [{ op: 'delete', scope: 'project', file: 'old.md', reason: 'stale' }],
    },
    { config: cfg, existingFiles: ['old.md'] },
  );
  const kept = retainedOps(result);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].op, 'delete');
  assert.equal(kept[0].file, 'old.md');
  assert.deepEqual(result.dropped, []);
});

test('validateDreamPlan never accepts reserved index files as write/delete targets', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ dreamAllowDelete: true });
  const result = validateDreamPlan(
    {
      summary: 'reserved targets',
      operations: [
        { op: 'delete', scope: 'project', file: 'MEMORY.md', reason: 'nope' },
        { op: 'delete', scope: 'project', file: '.dream-log.md', reason: 'nope' },
        { op: 'write', scope: 'project', file: 'MEMORY.md', type: 'user', name: 'x', description: 'd', body: 'b' },
      ],
    },
    { config: cfg, existingFiles: ['MEMORY.md', '.dream-log.md'] },
  );
  const kept = retainedOps(result);
  assert.equal(kept.length, 0, `reserved files must be dropped, kept: ${JSON.stringify(kept)}`);
  assert.ok(result.dropped.length >= 1);
});

test('validateDreamPlan enforces dreamMaxOps', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ dreamMaxOps: 2 });
  const ops = Array.from({ length: 5 }, (_, index) => ({
    op: 'write',
    scope: 'project',
    type: 'user',
    name: `entry_${index}`,
    description: `entry ${index}`,
    body: `body ${index}`,
  }));
  const result = validateDreamPlan({ summary: 'too many', operations: ops }, { config: cfg, existingFiles: [] });
  // Two acceptable contract readings: truncate to the limit and report the
  // excess in `dropped`, or reject the whole plan with ok:false + error.
  const retained = retainedOps(result);
  assert.equal(retained.length <= 2, true, `at most dreamMaxOps operations may be retained, got ${retained.length}`);
  const reported =
    result.dropped.length >= 1 ||
    (result.ok === false && /limit|operations|too many/i.test(String(result.error ?? '')));
  assert.equal(
    reported,
    true,
    'operations over the limit must be reported (dropped entries or ok:false + error)',
  );
});

test('validateDreamPlan enforces maxContentBytes on writes', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config({ maxContentBytes: 1024 });
  const result = validateDreamPlan(
    {
      summary: 'huge body',
      operations: [
        { op: 'write', scope: 'project', type: 'user', name: 'huge', description: 'd', body: 'x'.repeat(5000) },
        VALID_WRITE,
      ],
    },
    { config: cfg, existingFiles: [] },
  );
  const kept = retainedOps(result);
  assert.equal(kept.length, 1, 'oversized write must be dropped, valid write kept');
  assert.equal(kept[0].name, 'user_role');
  assert.ok(result.dropped.length >= 1);
});

test('validateDreamPlan enforces op type and memory type enums', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config();
  const result = validateDreamPlan(
    {
      summary: 'bad enums',
      operations: [
        { op: 'rename', scope: 'project', file: 'a.md' },
        { op: 'write', scope: 'project', type: 'bogus', name: 'x', description: 'd', body: 'b' },
        VALID_WRITE,
      ],
    },
    { config: cfg, existingFiles: [] },
  );
  const kept = retainedOps(result);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].op, 'write');
  assert.equal(kept[0].type, 'user');
  assert.ok(result.dropped.length >= 2);
});

test('validateDreamPlan returns ok:false for malformed plans instead of throwing', async () => {
  const { validateDreamPlan } = await dreamHelpers();
  const cfg = await config();
  for (const malformed of [null, undefined, {}, { summary: 'no ops' }, { operations: 'not-an-array' }, []]) {
    let result;
    assert.doesNotThrow(() => {
      result = validateDreamPlan(malformed, { config: cfg, existingFiles: [] });
    }, `validateDreamPlan(${JSON.stringify(malformed)}) must not throw`);
    assert.equal(result && result.ok, false, `validateDreamPlan(${JSON.stringify(malformed)}) must be ok:false`);
    assert.ok(Array.isArray(result.dropped), 'dropped must still be an array');
  }
});

test('dream prompt module exposes the system prompt and builder', async () => {
  const promptMod = await loadModule('../src/dream-prompt.js', { requireExports: ['DREAM_SYSTEM_PROMPT', 'buildDreamPrompt'] });
  assert.equal(typeof promptMod.DREAM_SYSTEM_PROMPT, 'string');
  assert.ok(promptMod.DREAM_SYSTEM_PROMPT.length > 100, 'system prompt must not be a stub');

  const input = { memory: { index: '', files: [] }, sessions: [], chars: 0, truncated: false };
  let built = '';
  assert.doesNotThrow(() => {
    built = promptMod.buildDreamPrompt(input);
  }, 'buildDreamPrompt must accept the documented gatherDreamInput shape');
  assert.equal(typeof built, 'string');
  assert.ok(built.length > 0);

  const combined = `${promptMod.DREAM_SYSTEM_PROMPT}\n${built}`;
  assert.match(combined, /evidence/i, 'dream prompt must ask for evidence');
  assert.match(combined, /json/i, 'dream prompt must demand JSON output');
  assert.match(combined, /operations/i, 'dream prompt must describe the operations schema');
});

// ---------------------------------------------------------------------------
// LLM completion budget / max-tokens retry
// ---------------------------------------------------------------------------

/** Tiny async-iterable stub of one `ctx.llm.stream(...)` response. */
function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

/** A chunk sequence that reports a truncated (max-tokens) finish. */
function truncatedResponse(text = 'partial plan') {
  return [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'max-tokens' } }];
}

/** A chunk sequence that finishes normally. */
function completeResponse(text) {
  return [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }];
}

async function dreamEngineWithStreams(t, configOverrides, responses) {
  const { DreamEngine } = await loadModule('../src/dream.js', { requireExports: ['DreamEngine'] });
  const cfg = await config(configOverrides);
  const calls = [];
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined;
      return {
        stream(options) {
          calls.push(options);
          const next = responses[Math.min(calls.length - 1, responses.length - 1)];
          return streamOf(next);
        },
      };
    },
  };
  const engine = new DreamEngine({ ctx, runtime: {}, config: cfg });
  return { engine, calls, cfg };
}

test('complete() retries once with double the output budget after a max-tokens finish', async (t) => {
  const { engine, calls, cfg } = await dreamEngineWithStreams(t, {}, [
    truncatedResponse('first attempt was truncated'),
    completeResponse('{"summary":"ok","operations":[]}'),
  ]);
  const text = await engine.complete({ model: { provider: 'local', model: 'tiny' }, prompt: 'consolidate' });
  assert.equal(text, '{"summary":"ok","operations":[]}');
  assert.equal(calls.length, 2, 'a truncated first call must be retried exactly once');
  assert.equal(calls[0].maxTokens, cfg.llmMaxTokens, 'first attempt uses the configured budget');
  assert.equal(calls[0].maxTokens, 16_384, 'default dream output budget is 16384 tokens');
  assert.equal(calls[1].maxTokens, 32_768, 'retry doubles the budget');
  assert.equal(calls[0].purpose, 'cc-memory-dream');
  assert.equal(calls[1].purpose, 'cc-memory-dream');
});

test('complete() caps the retry budget at 32768 tokens', async (t) => {
  const { engine, calls, cfg } = await dreamEngineWithStreams(t, { llmMaxTokens: 20_000 }, [
    truncatedResponse(),
    completeResponse('{"summary":"ok","operations":[]}'),
  ]);
  assert.equal(cfg.llmMaxTokens, 20_000);
  await engine.complete({ model: { provider: 'local', model: 'tiny' }, prompt: 'consolidate' });
  assert.deepEqual(
    calls.map((call) => call.maxTokens),
    [20_000, 32_768],
    'double budget is capped at 32768',
  );
});

test('complete() surfaces the max-tokens error when the retry is truncated too', async (t) => {
  const { engine, calls } = await dreamEngineWithStreams(t, {}, [
    truncatedResponse(),
    truncatedResponse('still truncated'),
  ]);
  await assert.rejects(
    engine.complete({ model: { provider: 'local', model: 'tiny' }, prompt: 'consolidate' }),
    (error) => {
      assert.equal(error.code, 'DREAM_MAX_TOKENS');
      assert.match(String(error.message), /max-tokens|llmMaxTokens/i);
      return true;
    },
  );
  assert.equal(calls.length, 2, 'exactly one retry is attempted');
});

test('complete() does not retry non-max-tokens failures', async (t) => {
  const { engine, calls } = await dreamEngineWithStreams(t, {}, [
    [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }],
  ]);
  await assert.rejects(
    engine.complete({ model: { provider: 'local', model: 'tiny' }, prompt: 'consolidate' }),
    /provider exploded/,
  );
  assert.equal(calls.length, 1, 'other LLM failures must not be retried');
});

