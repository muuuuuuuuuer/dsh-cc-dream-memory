import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeEnv } from './v10-helpers.mjs';
import { makeTempDir } from './helpers.mjs';
import { resolveIdentity } from '../src/identity.js';

test('v19 identity: bare repo and separate-git-dir roots are git identities, not workspace', async (t) => {
  const tmp = await makeTempDir(t);
  const bare = path.join(tmp, 'bare.git');
  await mkdir(path.join(bare, 'objects'), { recursive: true });
  await writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  assert.equal(resolveIdentity({ workspaceDir: bare, config: {} }).source, 'git');

  const sep = path.join(tmp, 'sep-gitdir');
  await mkdir(path.join(sep, 'objects'), { recursive: true });
  await writeFile(path.join(sep, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const main = path.join(tmp, 'main');
  await mkdir(main, { recursive: true });
  await writeFile(path.join(main, '.git'), `gitdir: ${sep}\n`, 'utf8');
  assert.equal(resolveIdentity({ workspaceDir: main, config: {} }).source, 'git');
});

test('v19 index: injectedIndex reports real size, not only the sampled head', async (t) => {
  const env = await makeEnv(t, { indexMaxLines: 5, indexMaxBytes: 10_000 });
  const lines = Array.from({ length: 9 }, (_, index) => `- [记忆 ${index}](memory_${index}.md) — 说明 ${index}`);
  await env.store.writeIndex(`${lines.join('\n')}\n`);
  const index = await env.store.injectedIndex('project');
  assert.equal(index.truncated, true);
  assert.equal(index.totalLines, 9, 'real line count must be reported');
  assert.ok(index.totalBytes > index.bytes, 'real byte count must exceed the sampled head');
  assert.ok(index.lines <= 5);
});
