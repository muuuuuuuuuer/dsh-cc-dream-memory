/** The classic dream prompt is deleted; its delete gate default is still live. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './v10-helpers.mjs';

test('v11 config: dreamAllowDelete defaults to true (soft delete to trash) and validates', async (t) => {
  const env = await makeEnv(t);
  assert.equal(env.config.dreamAllowDelete, true, 'v11 flips dreamAllowDelete on by default');
  const disabled = env.mods.config.resolveConfig({ memoryRoot: env.memoryRoot, dreamAllowDelete: false });
  assert.equal(disabled.dreamAllowDelete, false);
});
