import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runtimeEnv, commandEnv, httpEnv, callHttp, seedUserMessages } from './v10-helpers.mjs';

test('preflight estimates Dream input without calling a model or advancing session state', async t => {
  const e = await runtimeEnv(t, { dreamMaxTotalTokens: 25000, dreamCostMode: 'block' });
  await e.pctx.store.saveEntry({ type: 'project', name: 'Goal', description: 'Goal', content: 'Prepare a careful release.' });
  await e.pctx.state.ensureSession('pending-session', 1);
  // The estimate reads the same transcripts a run would; without a session
  // query there is nothing to count.
  seedUserMessages(e, 'Prepare a careful release.');
  const stateBefore = await readFile(e.pctx.paths.stateFile, 'utf8');
  const indexBefore = await e.pctx.store.indexText();
  const service = e.mods.status.createStatusService(e.runtime);
  const response = await service.dream(e.pctx, { action: 'estimate' });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.result.estimatedTokens > 0);
  assert.ok(response.result.inputChars > 0);
  assert.equal(response.result.limit, 25000);
  assert.equal(response.result.costMode, 'block');
  assert.equal(response.result.rough, true);
  assert.equal(e.host.llmCalls.length, 0);
  assert.equal(await readFile(e.pctx.paths.stateFile, 'utf8'), stateBefore);
  assert.equal(await e.pctx.store.indexText(), indexBefore);
});

test('preflight reports an unlimited configuration explicitly', async t => {
  const e = await runtimeEnv(t, { dreamMaxTotalTokens: 0 });
  const service = e.mods.status.createStatusService(e.runtime);
  const response = await service.dream(e.pctx, { action: 'estimate' });
  assert.equal(response.ok, true);
  assert.equal(response.result.limit, 0);
  assert.equal(e.host.llmCalls.length, 0);
});

test('the slash command exposes the no-model estimate before an optional dry-run', async t => {
  const e = await commandEnv(t, { dreamMaxTotalTokens: 25000 });
  const result = await e.invokeMemory('dream estimate');
  assert.equal(result.kind, 'success', JSON.stringify(result));
  assert.match(result.message ?? result.text ?? JSON.stringify(result), /input estimate.*tokens[\s\S]*25000/i);
  assert.equal(e.host.llmCalls.length, 0);
});

test('the authenticated HTTP Dream endpoint supplies the cost preview without model usage', async t => {
  const e = await httpEnv(t, { dreamMaxTotalTokens: 25000 });
  const response = await callHttp(e, { path: '/dream', method: 'POST', body: { action: 'estimate' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.ok(body.result.estimatedTokens > 0);
  assert.equal(body.result.limit, 25000);
  assert.equal(e.host.llmCalls.length, 0);
});
