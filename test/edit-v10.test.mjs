/**
 * v10 P1-7: edit / merge / file history (status service + HTTP + commands).
 * Contract §2. os.tmpdir() only; no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, commandEnv, httpEnv, callHttp, exists } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

async function statusService(env) {
  return env.mods.status.createStatusService(env.runtime);
}

async function seed(env, name, { type = 'user', description = `${name} description`, content = `${name} body` } = {}) {
  const saved = await env.pctx.store.saveEntry({ name, type, description, content });
  return saved;
}

test('v10 edit: writeFile creates and updates memory files with api:edit provenance', async (t) => {
  const env = await runtimeEnv(t);
  const service = await statusService(env);

  const created = await service.writeFile(env.pctx, {
    name: 'edited note',
    type: 'user',
    description: 'created through the editor',
    content: 'a body written through the edit API',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(typeof created.file, 'string');
  const readCreated = await env.pctx.store.readEntry(created.file);
  assert.equal(readCreated.frontmatter.via, 'api:edit');
  assert.match(readCreated.frontmatter.created, /^\d{4}-\d{2}-\d{2}T/);

  // A panel save is a user-confirmed save: the saved bytes go into the
  // verification ledger, so a later session may show this note's summary.
  const ledger = await loadModule('../src/verification-ledger.js', { requireExports: ['readLedger'] });
  const recorded = await ledger.readLedger(env.pctx.store);
  assert.equal(recorded.entries[created.file]?.source, 'user-explicit');

  // Update keeps created, rewrites content, provenance becomes api:edit.
  const seeded = await service.writeFile(env.pctx, {
    name: 'update me',
    type: 'user',
    description: 'original description',
    content: 'original body long enough',
  });
  const readBefore = await env.pctx.store.readEntry(seeded.file);
  const opened = await service.file(env.pctx, seeded.file, 'project');
  assert.equal(typeof opened.version, 'string');
  assert.equal(typeof opened.expectedHash, 'string');
  const updated = await service.writeFile(env.pctx, {
    file: seeded.file,
    name: 'update me',
    type: 'user',
    description: 'updated description',
    content: 'updated body through the editor',
    expectedHash: opened.expectedHash,
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const readAfter = await env.pctx.store.readEntry(seeded.file);
  assert.equal(readAfter.frontmatter.created, readBefore.frontmatter.created, 'created is preserved on update');
  assert.equal(readAfter.frontmatter.via, 'api:edit');
  assert.match(readAfter.body, /updated body through the editor/);

  // Secret deny is enforced by the existing store scan.
  const denyEnv = await runtimeEnv(t, { secretScan: 'deny' });
  const denyService = await statusService(denyEnv);
  await assert.rejects(
    denyService.writeFile(denyEnv.pctx, {
      name: 'secret edit',
      type: 'user',
      description: 'secret',
      content: 'my key AKIAABCDEFGHIJKLMNOP',
    }),
    (error) => {
      assert.equal(error.code, 'SECRET_DETECTED');
      return true;
    },
  );
});

test('v10 edit: a stale baseline cannot overwrite a newer body', async (t) => {
  const env = await runtimeEnv(t);
  const service = await statusService(env);
  const note = await seed(env, 'two windows', { content: 'first body' });

  // Both windows open the page at the same version.
  const windowA = await service.file(env.pctx, note.file, 'project');
  const windowB = await service.file(env.pctx, note.file, 'project');
  const savedA = await service.writeFile(env.pctx, {
    file: note.file,
    name: 'two windows',
    type: 'user',
    description: 'A description',
    content: 'body written by window A',
    expectedHash: windowA.expectedHash,
  });
  assert.equal(savedA.ok, true, JSON.stringify(savedA));

  // B's baseline is older now: the store refuses the write and A's text stays.
  await assert.rejects(
    service.writeFile(env.pctx, {
      file: note.file,
      name: 'two windows',
      type: 'user',
      description: 'B description',
      content: 'body written by window B',
      expectedHash: windowB.expectedHash,
    }),
    (error) => {
      assert.equal(error.code, 'STALE_WRITE');
      return true;
    },
  );
  const afterB = await env.pctx.store.readEntry(note.file);
  assert.match(afterB.body, /body written by window A/);
  assert.equal(afterB.frontmatter.description, 'A description');

  // A page deleted meanwhile is not recreated by an editor holding its baseline.
  await service.deleteFile(env.pctx, note.file, 'project');
  await assert.rejects(
    service.writeFile(env.pctx, {
      file: note.file,
      name: 'two windows',
      type: 'user',
      description: 'A description',
      content: 'zombie body',
      expectedHash: savedA.expectedHash,
    }),
    (error) => {
      assert.equal(error.code, 'stale-write');
      return true;
    },
  );
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, note.file)), false);
});

test('v10 edit: mergeFiles writes a merged file, trashes the originals and reconciles the index', async (t) => {
  const env = await runtimeEnv(t);
  const service = await statusService(env);
  const first = await seed(env, 'merge a', { content: 'body of file A' });
  const second = await seed(env, 'merge b', { content: 'body of file B' });

  const merged = await service.mergeFiles(env.pctx, {
    files: [first.file, second.file],
    name: 'merged notes',
    type: 'project',
    description: 'both notes merged',
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, merged.file)), true);
  const read = await env.pctx.store.readEntry(merged.file);
  assert.match(read.body, /## .*merge a/, 'merged body has a section per source file');
  assert.match(read.body, /body of file A/);
  assert.match(read.body, /body of file B/);
  assert.deepEqual(merged.trashed.sort(), [first.file, second.file].sort());
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.file === first.file || entry.file === second.file), false, 'originals are trashed');
  assert.equal(entries.some((entry) => entry.file === merged.file), true);
  const audit = await env.pctx.store.auditIndex();
  assert.equal(audit.missing.length, 0, 'the index is reconciled after a merge');

  await assert.rejects(
    service.mergeFiles(env.pctx, { files: [first.file], name: 'too few', type: 'user' }),
    (error) => {
      assert.match(String(error.code ?? error.message), /invalid|files|merge/i);
      return true;
    },
  );
});

test('v10 edit: fileHistory reports provenance, changelog lines and dream plan references', async (t) => {
  const env = await runtimeEnv(t);
  const service = await statusService(env);
  const saved = await env.pctx.store.saveEntry({
    name: 'history note',
    type: 'user',
    description: 'history description',
    content: 'history body',
    source: { sessionId: 'sess-history', via: 'tool:memory_save' },
  });
  await env.pctx.store.writeChangelog(`## 2026-11-07T00:00:00.000Z\n- dream wrote ${saved.file}\n`);
  const batchDir = path.join(env.pctx.paths.dreamsDir, '2026-11-07T09-00-00');
  await mkdir(batchDir, { recursive: true });
  await writeFile(
    path.join(batchDir, 'meta.json'),
    JSON.stringify({ kind: 'dream-switch', stamp: '2026-11-07T09-00-00', appliedAt: Date.now(), files: [saved.file] }),
    'utf8',
  );

  const history = await service.fileHistory(env.pctx, saved.file);
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.equal(history.file, saved.file);
  assert.equal(history.provenance.via, 'tool:memory_save');
  assert.equal(history.provenance.sourceSession, 'sess-history');
  assert.match(history.provenance.created, /^\d{4}-\d{2}-\d{2}T/);
  const changelog = Array.isArray(history.changelog) ? history.changelog.join('\n') : String(history.changelog ?? '');
  assert.match(changelog, /dream wrote/);
  const refs = JSON.stringify(history.planRefs ?? []);
  assert.match(refs, /2026-11-07T09-00-00/, 'dream plan references are reported');
});

test('v10 edit: HTTP file/merge/file-history endpoints and commands', async (t) => {
  const env = await httpEnv(t);
  const service = await statusService(env);
  await seed(env, 'http edit base', { content: 'http base body' });

  const savedByApi = await callHttp(env, {
    method: 'POST',
    path: '/file',
    body: { name: 'http edit', type: 'user', description: 'edited over http', content: 'http edited body long enough' },
    origin: 'http://127.0.0.1:61784',
  });
  assert.equal(savedByApi.statusCode, 200, savedByApi.bodyText());
  assert.equal(savedByApi.json().ok, true);
  const apiFile = savedByApi.json().file;
  assert.ok(apiFile);

  const history = await callHttp(env, { path: `/file-history?file=${encodeURIComponent(apiFile)}` });
  assert.equal(history.statusCode, 200, history.bodyText());
  assert.equal(history.json().ok, true);

  const a = await seed(env, 'http merge a', { content: 'http A' });
  const b = await seed(env, 'http merge b', { content: 'http B' });
  const merged = await callHttp(env, {
    method: 'POST',
    path: '/merge',
    body: { files: [a.file, b.file], name: 'http merged', type: 'project', description: 'merged over http' },
  });
  assert.equal(merged.statusCode, 200, merged.bodyText());
  assert.equal(merged.json().ok, true);
  assert.ok(merged.json().file);

  assert.equal((await callHttp(env, { path: '/file-history?file=x.md', token: 'bad-token' })).statusCode, 401);

  const commandEnvV = await commandEnv(t);
  const seedA = await seed(commandEnvV, 'cmd merge a', { content: 'cmd A' });
  const seedB = await seed(commandEnvV, 'cmd merge b', { content: 'cmd B' });

  const historyOut = await commandEnvV.invokeMemory(`history ${seedA.file}`);
  assert.equal(historyOut.kind, 'success', historyOut.text);
  assert.match(historyOut.text, /via|created|history|provenance/i);

  const mergeOut = await commandEnvV.invokeMemory(`merge ${seedA.file} ${seedB.file}`);
  assert.equal(mergeOut.kind, 'success', mergeOut.text);
  assert.match(mergeOut.text, /merged|http|cmd/i);
});
