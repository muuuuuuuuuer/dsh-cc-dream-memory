import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv } from './v10-helpers.mjs';

test('reconcileIndex enforces the byte budget as well as the line cap', async (t) => {
  const env = await runtimeEnv(t, { indexMaxBytes: 640, indexMaxLines: 200 });
  for (let index = 0; index < 12; index += 1) {
    await env.pctx.store.saveEntry({
      scope: 'project',
      name: `long note ${index}`,
      type: 'project',
      description: `a deliberately long description that makes the index grow ${'x'.repeat(80)}`,
      content: `body ${index}`,
      source: { via: 'test' },
    });
  }
  await env.pctx.store.reconcileIndex('project');
  const raw = await env.pctx.store.indexText('project');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 640, `index is ${Buffer.byteLength(raw, 'utf8')} bytes`);
  const head = await env.pctx.store.injectedIndex('project');
  assert.ok(head.text.length > 0);
});
