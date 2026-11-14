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
  assert.equal(first.ready, true, JSON.stringify(first).slice(0, 300));

  await env.runtime.setOverrides({ autoMemoryEnabled: false });
  assert.equal(env.runtime.config.autoMemoryEnabled, false, 'runtime.config reflects the override immediately');
  const blocked = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.notEqual(blocked.ready, true, JSON.stringify(blocked).slice(0, 300));
  assert.match(JSON.stringify(blocked), /auto-memory-disabled/i, 'the engine sees the new toggle');

  await env.runtime.setOverrides({ autoMemoryEnabled: true });
  // A new conversation, so the retry has something to read.
  await scriptDream(env, { sessions: { s2: ['Toggles apply without a restart.'] }, claims: [claimOf('Toggles apply without a restart.')] });
  const retried = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(retried.ready === true || retried.skipped === true, true, JSON.stringify(retried).slice(0, 300));
});

test('v12 config-live: the user memory scope is gone, including through overrides', async (t) => {
  const env = await runtimeEnv(t);
  assert.equal('userMemoryEnabled' in env.config, false, 'config no longer carries a user-scope switch');
  await env.runtime.setOverrides({ userMemoryEnabled: true });
  assert.equal('userMemoryEnabled' in env.runtime.config, false, 'an override cannot resurrect the removed switch');
  await assert.rejects(
    env.pctx.store.saveEntry({
      scope: 'user',
      name: 'user toggle note',
      type: 'user',
      description: 'user scope',
      content: 'user scope body',
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_SCOPE', String(error.code));
      return true;
    },
  );

  const service = env.mods.status.createStatusService(env.runtime);
  const status = await service.status(env.pctx);
  assert.equal('userScope' in status, false, 'status reports no user scope');
});
