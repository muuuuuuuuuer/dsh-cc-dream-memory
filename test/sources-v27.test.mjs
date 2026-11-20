/**
 * Note sources: frontmatter list round trip, the host-side check, write
 * receipts, memory_read, and recall refusing notes whose anchors are gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../src/frontmatter.js';
import { checkSources, normalizeSources } from '../src/sources.js';
import { attachRecall } from '../src/recall.js';
import { makeTempDir } from './helpers.mjs';
import { runtimeEnv, streamOf, toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

test('frontmatter keeps sources as a list: flow, block and round trip', () => {
  const text = stringifyFrontmatter({ name: 'a', description: 'd', type: 'project', sources: ['src/a.js', 'b.js#run now'] }, 'body');
  assert.match(text, /^sources: \["src\/a\.js","b\.js#run now"\]$/m);
  assert.deepEqual(parseFrontmatter(text).data.sources, ['src/a.js', 'b.js#run now']);
  assert.deepEqual(parseFrontmatter('---\nname: a\nsources:\n  - src/a.js\n  - "b.js#x"\ntype: user\n---\nhi').data.sources, ['src/a.js', 'b.js#x']);
  assert.deepEqual(parseFrontmatter('---\nname: a\nsources: [x.js, y.js#z]\n---\nhi').data.sources, ['x.js', 'y.js#z']);
  assert.doesNotMatch(stringifyFrontmatter({ name: 'a', sources: [] }, 'b'), /sources/);
});

test('normalizeSources refuses escapes, absolute paths and more than ten', () => {
  assert.equal(normalizeSources(undefined), undefined);
  assert.deepEqual(normalizeSources(['src\\a.js', 'src/a.js#f', 'src/a.js#f']), ['src/a.js', 'src/a.js#f']);
  for (const bad of [['../secret'], ['a/../../b'], ['/etc/passwd'], ['C:/x'], [''], [3], 'src/a.js']) {
    assert.throws(() => normalizeSources(bad), { code: 'INVALID_SOURCES' }, JSON.stringify(bad));
  }
  assert.throws(() => normalizeSources(Array.from({ length: 11 }, (_, i) => `f${i}.js`)), { code: 'INVALID_SOURCES' });
});

test('checkSources: ok, missing, symbol missing, big file unknown, no model call', async (t) => {
  const root = await makeTempDir(t);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.js'), 'export function runRelease() {}\n');
  await writeFile(path.join(root, 'big.js'), `${'x'.repeat(1024 * 1024 + 1)} bigSymbol`);
  const check = await checkSources(root, ['src/a.js', 'src/a.js#runRelease', 'src/a.js#gone', 'src/nope.js', 'big.js#bigSymbol', '../outside.js']);
  assert.deepEqual(check.items.map((item) => item.status), ['ok', 'ok', 'symbol-missing', 'missing', 'unknown', 'outside']);
  assert.deepEqual(check.broken.map((item) => item.source), ['src/a.js#gone', 'src/nope.js', '../outside.js']);
  assert.deepEqual(await checkSources(root, []), { items: [], broken: [] });
});

test('memory_save stores sources, warns about a missing one, and memory_update keeps them', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project' });
  await mkdir(path.join(env.workspaceDir, 'src'), { recursive: true });
  await writeFile(path.join(env.workspaceDir, 'src', 'release.js'), 'export const publish = 1;\n');
  const save = env.definitions.get('memory_save');
  const saved = await save.execute({
    name: 'release-flow', type: 'project', description: 'how releases run', content: 'Releases run through publish.',
    sources: ['src/release.js#publish', 'src/gone.js'],
  }, exec);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.ok(saved.warnings.some((warning) => /src\/gone\.js: missing/.test(warning)), JSON.stringify(saved.warnings));
  const entry = await env.pctx.store.readEntry(saved.file);
  assert.deepEqual(entry.frontmatter.sources, ['src/release.js#publish', 'src/gone.js']);

  const read = await env.definitions.get('memory_read').execute({ file: saved.file }, exec);
  assert.deepEqual(read.sourcesCheck.map((item) => item.status), ['ok', 'missing']);
  assert.match(read.sourcesNote, /sources changed; verify before relying: src\/gone\.js \(missing\)/);

  const updated = await env.definitions.get('memory_update').execute({
    file: saved.file, content: 'Releases run through publish, then tag.', expectedHash: read.hash,
  }, exec);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual((await env.pctx.store.readEntry(saved.file)).frontmatter.sources, ['src/release.js#publish', 'src/gone.js']);
  await env.definitions.get('memory_read').execute({ file: saved.file }, exec);
  const cleared = await env.definitions.get('memory_update').execute({ file: saved.file, sources: [] }, exec);
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal((await env.pctx.store.readEntry(saved.file)).frontmatter.sources, undefined);
});

test('memory_save refuses a source outside the project root', async (t) => {
  const env = await toolsEnv(t, { userMemory: 'project' });
  const result = await env.definitions.get('memory_save').execute(
    { name: 'escape', type: 'project', description: 'd', content: 'body', sources: ['../../etc/passwd'] }, exec);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_SOURCES');
  assert.deepEqual(await env.pctx.store.listEntries(), []);
});

test('recall does not attach a note whose sources are broken', async (t) => {
  const env = await runtimeEnv(t, { recallMode: 'model', userMemory: 'project' });
  await writeFile(path.join(env.workspaceDir, 'live.js'), 'export const live = 1;\n');
  const good = await env.pctx.store.saveEntry({ name: 'anchored', type: 'project', description: 'anchored note', content: 'STATUS: current\nAnchored fact.', sources: ['live.js#live'] });
  const bad = await env.pctx.store.saveEntry({ name: 'drifted', type: 'project', description: 'drifted note', content: 'STATUS: current\nDrifted fact.', sources: ['live.js#removed'] });
  env.host.services.llm = {
    stream: () => streamOf([{ type: 'text-delta', text: JSON.stringify({ selected_memories: [good.file, bad.file] }) }, { type: 'finish', reason: { kind: 'stop' } }]),
  };
  const handlers = [];
  const agentCtx = { on: (_event, handler) => { handlers.push(handler); return () => {}; } };
  env.runtime.forAgent = async () => env.pctx;
  attachRecall({ agent: { id: 's1', ctx: agentCtx }, agentCtx, runtime: env.runtime, config: () => env.runtime.config });
  const messages = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'anything about the facts' }], source: { kind: 'user' } }];
  const decision = await handlers[0]({ messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [...messages] }));
  const text = decision.messages.at(-1).content[0].text;
  assert.match(text, /Anchored fact/);
  assert.doesNotMatch(text, /Drifted fact/);
});
