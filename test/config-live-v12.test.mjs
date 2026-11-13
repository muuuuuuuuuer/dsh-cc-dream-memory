/**
 * v12 Bug 1: runtime toggles must take effect on the already-created store /
 * dream engine (no runtime rebuild).
 * Contract `docs/superpowers/specs/2026-11-08-v12-review-fixes.md` Bug 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv, scriptDream, claimOf } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

test('v12 config-live: autoMemoryEnabled toggles reach the existing dream engine', async (t) => {
  const env = await runtimeEnv(t);
  await scriptDream(env, { sessions: { s1: ['Live config is read on every run.'] }, claims: [claimOf('Live config is read on every run.')] });
  const first = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(first.applied, true, JSON.stringify(first).slice(0, 300));

  await env.runtime.setOverrides({ autoMemoryEnabled: false });
  assert.equal(env.runtime.config.autoMemoryEnabled, false, 'runtime.config reflects the override immediately');
  const blocked = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.notEqual(blocked.applied, true, JSON.stringify(blocked).slice(0, 300));
  assert.match(JSON.stringify(blocked), /auto-memory-disabled/i, 'the old engine sees the new toggle');

  await env.runtime.setOverrides({ autoMemoryEnabled: true });
  // A new conversation, so the retry has something to read.
  await scriptDream(env, { sessions: { s2: ['Toggles apply without a restart.'] }, claims: [claimOf('Toggles apply without a restart.')] });
  const retried = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(retried.applied, true, JSON.stringify(retried).slice(0, 300));
});

test('v12 config-live: userMemoryEnabled toggles reach the existing store and injection', async (t) => {
  const env = await runtimeEnv(t);
  assert.equal(env.config.userMemoryEnabled, false);
  await assert.rejects(
    env.pctx.store.saveEntry({
      scope: 'user',
      name: 'user toggle note',
      type: 'user',
      description: 'user scope',
      content: 'user scope body',
    }),
    (error) => {
      assert.match(String(error.code ?? ''), /SCOPE_DISABLED|scope/i);
      return true;
    },
  );

  await env.runtime.setOverrides({ userMemoryEnabled: true });
  assert.equal(env.runtime.config.userMemoryEnabled, true);
  const saved = await env.pctx.store.saveEntry({
    scope: 'user',
    name: 'user toggle note',
    type: 'user',
    description: 'user scope',
    content: 'user scope body',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const userIndex = await env.pctx.store.injectedIndex('user');
  assert.match(userIndex.text, /user toggle note/, 'the user index contains the new entry');

  const { buildInjectionText } = await loadModule('../src/inject.js', { requireExports: ['buildInjectionText'] });
  const text = buildInjectionText({
    memoryDir: env.pctx.paths.memoryDir,
    userMemoryDir: env.pctx.paths.userMemoryDir,
    config: env.runtime.config,
    index: await env.pctx.store.injectedIndex('project'),
    user: userIndex,
    rules: '',
  });
  assert.match(String(text), /user toggle note/, 'the injected text carries the user memory index');

  const service = env.mods.status.createStatusService(env.runtime);
  const status = await service.status(env.pctx);
  assert.equal(status.userScope.enabled, true);
  assert.ok(status.userScope.entries.some((entry) => entry.name === 'user toggle note'));
});
