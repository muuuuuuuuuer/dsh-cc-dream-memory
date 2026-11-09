/**
 * v10 P1-8: ranked search + memory_recall + HTTP /search + /memory search.
 * Contract §3. os.tmpdir() only; no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeEnv, toolsEnv, commandEnv, httpEnv, memoryFile, callHttp } from './v10-helpers.mjs';

async function seedRaw(env, items) {
  const written = [];
  for (const item of items) {
    const file = item.file;
    await writeFile(
      path.join(env.pctx.paths.memoryDir, file),
      memoryFile({ name: item.name, type: item.type ?? 'user', description: item.description, modified: item.modified }, item.body),
      'utf8',
    );
    written.push({ ...item, file });
  }
  await env.pctx.store.writeIndex(written.map((item) => ({ name: item.name, file: item.file, description: item.description })).map((item) => `- [${item.name}](${item.file}) — ${item.description}`).join('\n') + '\n');
  return written;
}

const OLD = '2026-01-01T00:00:00.000Z';
const RECENT = '2026-11-07T10:00:00.000Z';

test('v10 search: ranks name hits over description and body hits', async (t) => {
  const env = await makeEnv(t);
  await seedRaw(env, [
    { file: 'user_body.md', name: 'body match', description: 'misc', body: 'many words about a zebra in the body' },
    { file: 'user_description.md', name: 'description match', description: 'a zebra description', body: 'unrelated words' },
    { file: 'user_name.md', name: 'zebra', description: 'name match', body: 'unrelated words' },
  ]);
  const results = await env.store.search('zebra');
  assert.ok(results.length >= 3, JSON.stringify(results.map((item) => item.file)));
  assert.equal(results[0].file, 'user_name.md', 'the name hit ranks first');
  const indexOfDescription = results.findIndex((item) => item.file === 'user_description.md');
  const indexOfBody = results.findIndex((item) => item.file === 'user_body.md');
  assert.ok(indexOfDescription < indexOfBody, 'description hits rank above body hits');
  for (const item of results) {
    assert.equal(typeof item.score, 'number');
    assert.ok(Array.isArray(item.snippets), 'search results expose snippets');
  }
});

test('v10 search: phrase bonus boosts an exact phrase over scattered words', async (t) => {
  const env = await makeEnv(t);
  await seedRaw(env, [
    { file: 'user_scattered.md', name: 'scattered', description: 'scattered words', body: 'alpha then some other words then beta' },
    { file: 'user_phrase.md', name: 'phrase', description: 'phrase words', body: 'the alpha beta pair appears together' },
  ]);
  const results = await env.store.search('alpha beta');
  const phrase = results.find((item) => item.file === 'user_phrase.md');
  const scattered = results.find((item) => item.file === 'user_scattered.md');
  assert.ok(phrase && scattered);
  assert.ok(phrase.score > scattered.score, `phrase bonus expected: ${phrase.score} > ${scattered.score}`);
});

test('v10 search: recency is a tie-breaker and type/offset/limit are supported', async (t) => {
  const env = await makeEnv(t);
  await seedRaw(env, [
    { file: 'user_old.md', name: 'tie old', description: 'tie note', body: 'identical tie body', modified: OLD, type: 'feedback' },
    { file: 'user_recent.md', name: 'tie recent', description: 'tie note', body: 'identical tie body', modified: RECENT, type: 'feedback' },
    { file: 'user_ref.md', name: 'reference tie', description: 'tie note', body: 'identical tie body', modified: RECENT, type: 'reference' },
  ]);
  const results = await env.store.search('identical tie body', { limit: 10 });
  assert.ok(results.length === 3);
  assert.equal(results[0].file, 'user_recent.md', 'the more recently modified entry wins the tie');

  const filtered = await env.store.search('identical tie body', { type: 'feedback', limit: 10 });
  assert.deepEqual(filtered.map((item) => item.file).sort(), ['user_old.md', 'user_recent.md']);
  for (const item of filtered) assert.equal(item.type, 'feedback');

  const offset = await env.store.search('identical tie body', { limit: 1, offset: 1 });
  assert.equal(offset.length, 1);
  assert.equal(offset[0].file, results[1].file, 'offset skips the first ranked item');
});

test('v10 search: memory_search absorbed recall ranking (score/snippets)', async (t) => {
  const env = await toolsEnv(t);
  await seedRaw(env, [
    { file: 'user_recall_a.md', name: 'recall zebra', description: 'recall description', body: 'recall body zebra for the test' },
    { file: 'user_recall_b.md', name: 'other recall', description: 'other zebra', body: 'other body' },
  ]);
  // v11: memory_recall is folded into memory_search (same ranking engine).
  assert.equal(env.definitions.has('memory_recall'), false, 'memory_recall is no longer registered');
  const tool = env.definitions.get('memory_search');
  assert.ok(tool);
  const result = await tool.execute({ query: 'zebra', limit: 1 }, { agent: { id: 'agent-1' }, sessionId: 'sess-1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const items = result.items ?? result.hits ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0].file, 'user_recall_a.md');
  assert.equal(typeof items[0].score, 'number');
  assert.ok(Array.isArray(items[0].snippets) && items[0].snippets.length >= 1);
});

test('v10 search: HTTP GET /search and /memory search command', async (t) => {
  const env = await httpEnv(t);
  await seedRaw(env, [
    { file: 'user_http_search.md', name: 'http zebra', description: 'http search note', body: 'http search body' },
    { file: 'user_http_other.md', name: 'other note', description: 'http zebra description', body: 'other body' },
  ]);
  const res = await callHttp(env, { path: '/search?q=zebra&limit=1&offset=0' });
  assert.equal(res.statusCode, 200, res.bodyText());
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(Array.isArray(body.items), true);
  assert.equal(body.items.length, 1);
  assert.equal(typeof body.total, 'number');
  assert.ok(body.total >= 2);

  const typed = await callHttp(env, { path: '/search?q=zebra&type=reference' });
  assert.equal(typed.statusCode, 200);
  assert.equal(typed.json().ok, true);

  const commandEnvV = await commandEnv(t);
  await seedRaw(commandEnvV, [
    { file: 'user_cmd_search.md', name: 'command zebra', description: 'command search note', body: 'command search body' },
  ]);
  const output = await commandEnvV.invokeMemory('search zebra');
  assert.equal(output.kind, 'success', output.text);
  assert.match(output.text, /zebra|command zebra/i);
});
