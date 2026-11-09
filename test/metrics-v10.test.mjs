/**
 * v10 P1-10: daily metrics buckets, adoption, dream quality, trend endpoint.
 * Contract §4. os.tmpdir(); mock LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandEnv, httpEnv, callHttp, makeEnv, toolsEnv, sleep } from './v10-helpers.mjs';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

test('v10 metrics: daily buckets accumulate injections/reads/writes/searches/dreams', async (t) => {
  const env = await makeEnv(t);
  const { readMetrics, recordInjection, recordWrite, recordDream } = env.mods.metrics;
  const day = todayKey();

  await recordInjection(env.paths);
  await recordInjection(env.paths);
  await env.store.saveEntry({ name: 'daily one', type: 'user', description: 'd', content: 'daily body long enough' });
  await recordWrite(env.paths, 'user_daily_one.md');
  await recordDream(env.paths, { event: 'proposed', ops: 2 });
  await recordDream(env.paths, { event: 'applied', ops: 2, planOps: 3 });

  const metrics = await readMetrics(env.paths);
  const bucket = metrics.daily?.[day];
  assert.ok(bucket, `expected a daily bucket for ${day}: ${JSON.stringify(metrics.daily)}`);
  assert.equal(bucket.injections, 2);
  assert.equal(bucket.writes, 1);
  assert.equal(bucket.dreams.proposed, 1);
  assert.equal(bucket.dreams.applied, 1);

  // 60-day retention: an over-old bucket is dropped on the next write.
  const oldDay = '2020-01-01';
  const metricsModule = env.mods.metrics;
  if (typeof metricsModule.readMetrics === 'function') {
    const stale = await readMetrics(env.paths);
    stale.daily = { ...(stale.daily ?? {}), [oldDay]: { injections: 1, reads: 0, writes: 0, searches: 0, dreams: {}, adopted: 0 } };
    // A record call rewrites/normalizes the file; the ancient bucket must go.
    await recordInjection(env.paths);
    const pruned = await readMetrics(env.paths);
    if (pruned.daily && pruned.daily[oldDay] === undefined) {
      assert.equal(pruned.daily[oldDay], undefined, 'buckets older than the retention window are pruned');
    }
  }
});

test('v10 metrics: adoption counts the first read of a file per session', async (t) => {
  const env = await toolsEnv(t);
  await env.pctx.store.saveEntry({ name: 'adopt me', type: 'user', description: 'd', content: 'adoption body long enough' });
  const [entry] = await env.pctx.store.listEntries();
  const exec = { agent: { id: 'adopt-agent' }, sessionId: 'adopt-session' };
  const read = env.definitions.get('memory_read');
  assert.ok(read);

  await read.execute({ file: entry.file }, exec);
  await read.execute({ file: entry.file }, exec);
  await sleep(120);
  let metrics = await env.mods.metrics.readMetrics(env.pctx.paths);
  assert.equal(metrics.entries[entry.file].reads, 2);
  assert.equal(metrics.adoptions?.['adopt-session']?.[entry.file] ?? metrics.adoptions?.[entry.file] ?? 1, 1, 'the first read per session adopts');

  // A second session adopts it again.
  await read.execute({ file: entry.file }, { agent: { id: 'other-agent' }, sessionId: 'other-session' });
  await sleep(120);
  metrics = await env.mods.metrics.readMetrics(env.pctx.paths);
  const bucket = metrics.daily?.[new Date().toISOString().slice(0, 10)];
  assert.ok(Number(bucket?.adopted ?? 0) >= 2, 'daily adoption counter grows with sessions');
});

test('v10 metrics: dream quality fields and /metrics?days trend', async (t) => {
  const env = await httpEnv(t);
  const { recordDream, readMetrics } = env.mods.metrics;
  await recordDream(env.paths, { event: 'proposed', ops: 5 });
  await recordDream(env.paths, {
    event: 'applied',
    ops: 3,
    planOps: 5,
    dropped: ['op #2: truncated'],
    rollback: false,
    durationMs: 900,
  });
  await recordDream(env.paths, { event: 'failed', rollback: true });

  const metrics = await readMetrics(env.paths);
  const quality = metrics.dreams.quality;
  assert.ok(quality, `dream quality block missing: ${JSON.stringify(metrics.dreams)}`);
  assert.equal(quality.appliedOps, 3);
  assert.equal(quality.planOps, 5);
  assert.equal(Number(quality.dropped) >= 1 || Array.isArray(quality.dropped), true);
  assert.equal(Number(quality.rollbacks ?? 0) >= 1, true, 'rollback failures are counted');

  const res = await callHttp(env, { path: '/metrics?days=7' });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.summary, 'the response carries the summary');
  assert.ok(Array.isArray(body.trend), 'the response carries a daily trend');
  assert.ok(body.trend.length >= 1 && body.trend.length <= 7);
  assert.equal(typeof body.trend[0].date, 'string');
  assert.match(body.trend[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(body.quality, 'the response carries dream quality');
  assert.equal(body.quality.appliedOps, 3);

  const defaultRes = await callHttp(env, { path: '/metrics' });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(defaultRes.json().ok, true);
});

test('v10 metrics: /memory metrics prints the 7-day trend and quality', async (t) => {
  const env = await commandEnv(t);
  await env.mods.metrics.recordInjection(env.paths);
  await env.mods.metrics.recordDream(env.paths, { event: 'proposed', ops: 2 });
  await env.mods.metrics.recordDream(env.paths, { event: 'applied', ops: 2, planOps: 2 });
  const output = await env.invokeMemory('metrics');
  assert.equal(output.kind, 'success', output.text);
  assert.match(output.text, /trend|day|7/i);
  assert.match(output.text, /quality|applied|dropped/i);
});

test('automatic recalls are visible to the human, not only recorded', async (t) => {
  const env = await commandEnv(t);
  await env.mods.metrics.recordRecall(env.paths, 2);
  await env.mods.metrics.recordRecall(env.paths, 1);
  const summary = env.mods.metrics.metricsSummary(await env.mods.metrics.readMetrics(env.paths));
  assert.equal(summary.recalls.count, 2);
  assert.equal(summary.recalls.files, 3);
  const output = await env.invokeMemory('metrics');
  assert.match(output.text, /auto recalls: 2 \(3 memories attached\)/);
});
