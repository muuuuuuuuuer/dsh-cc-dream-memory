/**
 * v12 design fix 3: injected hints must not tell the model to do things it
 * cannot do, must not leak absolute memory paths, and must prefer
 * memory_update over destructive consolidation advice.
 * Contract §设计问题修复 3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, runtimeEnv } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

let injectPromise;

function injectModule() {
  if (!injectPromise) {
    injectPromise = loadModule('../src/inject.js', { requireExports: ['buildInjectionText'] });
  }
  return injectPromise;
}

function index(lines) {
  return { text: lines.join('\n'), lines: lines.length, bytes: lines.join('\n').length, truncated: false, overflow: false };
}

async function injectionText(env, extra = {}) {
  const mods = await injectModule();
  return mods.buildInjectionText({
    memoryDir: env.pctx.paths.memoryDir,
    userMemoryDir: env.pctx.paths.userMemoryDir,
    config: env.runtime.config,
    index: index(['- [note](user_note.md) — a note']),
    user: null,
    rules: '',
    ...extra,
  });
}

test('v12 prompt: injected text has no model-impossible dream/merge instructions', async (t) => {
  const env = await runtimeEnv(t);
  const text = await injectionText(env);
  assert.doesNotMatch(text, /\/memory dream run/, 'the model cannot run /memory commands');
  assert.doesNotMatch(text, /merge duplicates and delete stale entries/i, 'destructive consolidation advice is removed');
  assert.doesNotMatch(text, /\/memory /, 'no slash-command instructions in the model injection');
  assert.match(text, /memory_update/i, 'the updated advice prefers memory_update');
});

test('v12 prompt: gives today\'s date, so an absolute date in a note is not a guess', async (t) => {
  const env = await runtimeEnv(t);
  const text = await injectionText(env, { now: new Date(2026, 10, 9, 12) });
  assert.match(text, /Today's date is 2026-11-09\./);
});

test('v12 prompt: injected text does not leak absolute memory paths', async (t) => {
  const env = await runtimeEnv(t);
  const text = await injectionText(env);
  assert.equal(text.includes(env.pctx.paths.memoryDir), false, 'no absolute project memory path');
  assert.equal(text.includes(env.pctx.paths.userMemoryDir), false, 'no absolute user memory path');
  assert.equal(text.includes(env.pctx.paths.projectDir), false, 'no absolute project dir');
  assert.doesNotMatch(text, /[A-Za-z]:\\\\|[A-Za-z]:\//, 'no windows drive-letter memory path');
});

test('v12 prompt: budget notice avoids the removed dream-run command and names the human path', async (t) => {
  const env = await makeEnv(t);
  const mods = await injectModule();
  const overflowIndex = {
    text: Array.from({ length: 120 }, (_, i) => `- [n${i}](user_n${i}.md) — note ${i}`).join('\n'),
    lines: 120,
    bytes: 4000,
    truncated: true,
    overflow: true,
  };
  const text = mods.buildInjectionText({
    memoryDir: env.paths.memoryDir,
    userMemoryDir: env.paths.userMemoryDir,
    config: env.config,
    index: overflowIndex,
    user: null,
    rules: '',
  });
  assert.match(text, /budget|over budget|truncat/i, 'the overflow notice is present');
  assert.doesNotMatch(text, /\/memory dream run/, 'the old command hint is gone');
  assert.match(text, /Memory page|human can consolidate|consolidat/i, 'the notice points at the human consolidation path');
});
