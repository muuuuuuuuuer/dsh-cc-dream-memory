/**
 * v11 step 3: dream prompt consolidation rules + dreamAllowDelete default.
 * Contract `docs/superpowers/specs/2026-11-07-v11-user-six-steps.md` §3.
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

let promptModulePromise;

function promptModule() {
  if (!promptModulePromise) {
    promptModulePromise = loadModule('../src/dream-prompt.js', {
      requireExports: ['DREAM_SYSTEM_PROMPT', 'buildDreamPrompt'],
    });
  }
  return promptModulePromise;
}

function fullPrompt(env, mods) {
  const built = mods.buildDreamPrompt({
    memory: { index: '- [x](x.md) — x', files: [{ file: 'x.md', name: 'x', type: 'user', description: 'd', body: 'b' }] },
    sessions: [],
    truncatedFiles: [],
  });
  return `${mods.DREAM_SYSTEM_PROMPT}\n${built}`;
}

test('v11 prompt: dream prompt keeps still-true facts and replaces superseded state', async (t) => {
  await makeEnv(t);
  const mods = await promptModule();
  const text = fullPrompt(null, mods);

  assert.doesNotMatch(
    text,
    /preserve every fact from the previous version/i,
    'the old "preserve every fact" wording must be gone',
  );
  assert.doesNotMatch(text, /每一个事实/);
  assert.match(
    text,
    /still true|still valid|supersede|replace|取代|仍然成立|已经过时/i,
    'the prompt must say to keep still-true facts and replace superseded state',
  );
  // The replacement rule is explicit: do not carry the historical state along.
  assert.match(text, /do not (?:keep|preserve|carry).{0,80}(?:history|historical|old version|old state)|不保留历史|不再保留/i);
});

test('v11 prompt: dream prompt forbids volatile bookkeeping facts', async (t) => {
  await makeEnv(t);
  const mods = await promptModule();
  const text = fullPrompt(null, mods);

  for (const [label, pattern] of [
    ['version numbers', /version number|版本号|semver/i],
    ['test counts', /test count|测试数|测试数量/i],
    ['commit hashes', /commit hash|提交哈希|SHA-?1?[0-9a-f]{7,}/i],
    ['line counts', /line count|行数/i],
    ['progress logs', /progress (?:log|journal)|流水账|progress updates?/i],
    ['one-off transactions', /one-?off|一次性事务/i],
  ]) {
    assert.match(text, pattern, `the prompt must explicitly forbid ${label}`);
  }
});

test('v11 prompt: truncation safety marker is still documented', async (t) => {
  await makeEnv(t);
  const mods = await promptModule();
  const text = fullPrompt(null, mods);
  assert.match(text, /TRUNCATED IN INPUT|truncat/i, 'truncated files stay protected from rewrites');
});

test('v11 prompt: dreamAllowDelete defaults to true (soft delete to trash) and validates', async (t) => {
  const env = await makeEnv(t);
  assert.equal(env.config.dreamAllowDelete, true, 'v11 flips dreamAllowDelete on by default');
  const disabled = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, dreamAllowDelete: false });
  assert.equal(disabled.dreamAllowDelete, false);
});
