/**
 * Regression tests for the v25 audit fixes.
 *
 * These cover the data-loss and concurrency findings from the audit: lock
 * acquisition, shadow conflicts for notes created mid-run, pending-shadow
 * protection, Dream session read tracking, extractor delete stripping, and the
 * configured Dream model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, loadModule } from './helpers.mjs';
import { toolsEnv, streamOf, exists } from './v10-helpers.mjs';

const now = Date.parse('2026-11-15T10:00:00Z');

function toolCall(id, name, args) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: args } };
}

function stop() {
  return { type: 'finish', reason: { kind: 'stop' } };
}

test('withFileLock acquires even when waitMs is zero', async (t) => {
  const { withFileLock } = await loadModule('../src/lock.js', { requireExports: ['withFileLock'] });
  const dir = await makeTempDir(t, 'lock');
  const file = path.join(dir, 'project.lock');
  let observed = false;
  await withFileLock(file, async () => {
    observed = await exists(file);
  }, { waitMs: 0 });
  assert.equal(observed, true);
  assert.equal(await exists(file), false);
});

test('a note created during a Dream run is a conflict, not a deletion', async (t) => {
  const { prepareShadow, shadowConflicts, diffShadow, switchShadow } = await loadModule('../src/dream-shadow.js', {
    requireExports: ['prepareShadow', 'shadowConflicts', 'diffShadow', 'switchShadow'],
  });
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const store = env.pctx.store;
  await store.saveEntry({
    name: 'Existing',
    type: 'project',
    description: 'An existing note',
    content: 'old body',
    source: { via: 'test' },
  });
  const { shadowStore, base } = await prepareShadow({
    store,
    paths: env.pctx.paths,
    config: env.runtime.config,
  });

  const late = await store.saveEntry({
    name: 'Late note',
    type: 'project',
    description: 'Created after the shadow snapshot',
    content: 'do not delete me',
    source: { via: 'test' },
  });
  const lateFile = late.file;

  const conflicts = await shadowConflicts({ store, base });
  assert.ok(
    conflicts.some((item) => item.file === lateFile && /created while the dream ran/u.test(item.reason)),
    `expected a created-during-run conflict, got ${JSON.stringify(conflicts)}`,
  );

  const diff = await diffShadow({ store, shadowStore });
  const switched = await switchShadow({
    store,
    shadowStore,
    paths: env.pctx.paths,
    base,
    files: diff.files.map((item) => item.file),
  });
  assert.equal(switched.ok, false);
  assert.equal(switched.error, 'conflict');
  assert.equal(await exists(path.join(env.pctx.paths.memoryDir, lateFile)), true);
});

test('a manual Dream refuses to run while a shadow is pending', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  const shadowDir = path.join(env.pctx.paths.dreamsDir, 'shadow');
  await fs.mkdir(shadowDir, { recursive: true });
  const marker = path.join(shadowDir, 'marker.txt');
  await fs.writeFile(marker, 'pending', 'utf8');
  await env.pctx.state.setShadowPending({
    dir: shadowDir,
    createdAt: now,
    runId: 'old-run',
    summary: 'old pending shadow',
    base: {},
    files: [],
    counts: { added: 0, changed: 0, removed: 0 },
    sessions: [],
    proposals: {},
    links: {},
    verifiedFiles: [],
    verifiedClaims: [],
  });

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual' });
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'pending-switch');
  assert.equal(await exists(marker), true);
});

test('Dream records session reads as complete when the last seq is reached', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  await env.pctx.store.saveEntry({
    name: 'Deploy',
    type: 'project',
    description: 'Release process',
    content: 'Use make release.',
    source: { via: 'test' },
  });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000 } }],
    listEvents: async () => [{ seq: 0, type: 'turn/start' }, { seq: 7, type: 'user/message' }],
    searchEvents: async () => ({ items: [] }),
    readEvent: async () => ({
      events: [{ seq: 7, type: 'user/message', data: { content: [{ type: 'text', text: 'Use pnpm.' }] } }],
    }),
  };
  let call = 0;
  env.host.services.llm.stream = () => {
    call += 1;
    if (call === 1) {
      return streamOf([
        toolCall('c1', 'session_read', { session_id: 's1', seq: 7 }),
        toolCall('c3', 'memory_write', {
          file: 'project_deploy.md',
          name: 'Deploy',
          type: 'project',
          description: 'Release process uses pnpm',
          body: 'Use pnpm.',
        }),
        toolCall('c2', 'work_done', { session_id: 's1', through_seq: 7, summary: 'Reviewed the new release command.' }),
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]);
    }
    return streamOf([{ type: 'text-delta', text: 'DONE' }, stop()]);
  };

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-read-1' });
  assert.equal(result.ready, true);
  assert.deepEqual(env.pctx.state.snapshot().dreamProcessedSessions, []);
  const processed = env.pctx.state.snapshot().shadowPending.reviewRecords.find((item) => item.id === 's1');
  assert.ok(processed, 'completed review waits for settlement');
  assert.equal(processed.seq, 7);
  assert.equal(processed.partial, undefined);
});

test('auto-extract never forwards a delete to memory_update', async (t) => {
  const { runAutoExtract } = await loadModule('../src/auto-extract.js', { requireExports: ['runAutoExtract'] });
  const env = await toolsEnv(t, { autoExtract: true, autoExtractEveryTurns: 1 });
  const calls = [];
  env.runtime.memoryTools = new Map(
    ['memory_read', 'memory_search', 'memory_save', 'memory_update'].map((name) => [
      name,
      {
        name,
        description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (args) => {
          calls.push({ name, args: { ...args } });
          return { ok: true };
        },
      },
    ]),
  );
  env.host.services.sessionQuery = {
    readSession: async () => ({
      session: { id: 's1' },
      events: [{
        seq: 1,
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember this durable fact about the release process please.' }] },
      }],
    }),
  };
  let call = 0;
  env.host.services.llm.stream = () => {
    call += 1;
    if (call === 1) {
      return streamOf([
        toolCall('d1', 'memory_update', { file: 'project_x.md', delete: true, expectedHash: 'read-version' }),
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]);
    }
    return streamOf([{ type: 'text-delta', text: 'DONE' }, stop()]);
  };

  await runAutoExtract({ ctx: env.host, runtime: env.runtime, pctx: env.pctx, sessionId: 's1', agent: { id: 's1' } });
  const update = calls.find((item) => item.name === 'memory_update');
  assert.ok(update, 'memory_update should be executed');
  assert.equal(update.args.delete, undefined);
  assert.equal(update.args.expectedHash, 'read-version');
  assert.equal(env.pctx.state.snapshot().extractSeqs.s1, 1, 'cursor should persist in project state');
});

test('Dream session tools reject ids outside the candidate set', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  let searches = 0;
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000, lastSeq: 7 } }],
    searchEvents: async () => {
      searches += 1;
      return { items: [] };
    },
    readEvent: async () => ({ events: [] }),
  };
  const calls = [];
  let call = 0;
  env.host.services.llm.stream = (options) => {
    calls.push(options);
    call += 1;
    if (call === 1) {
      return streamOf([
        toolCall('x1', 'session_search', { session_id: 's2', query: 'secret' }),
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]);
    }
    return streamOf([{ type: 'text-delta', text: 'DONE' }, stop()]);
  };

  await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-candidate-1' });
  assert.equal(searches, 0, 'non-candidate session must not be searched');
  const lastTool = calls[1].messages.at(-1);
  const text = lastTool.content.map((block) => block.text || '').join(' ');
  assert.match(text, /not a candidate/);
});

test('Dream timeout aborts the tool loop, clears the shadow, and does not count as a failure', async (t) => {
  const env = await toolsEnv(t, {
    autoDreamEnabled: false,
    dreamTimeoutMs: 1_000,
    sessionLookback: 1,
  });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000, lastSeq: 7 } }],
    searchEvents: async () => ({ items: [] }),
    readEvent: async () => ({ events: [] }),
  };
  env.host.services.llm.stream = (options) => (async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2_000);
      const abort = () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
    yield { type: 'text-delta', index: 0, text: 'DONE' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();

  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-timeout-1' });
  assert.equal(result.error, 'timeout');
  assert.equal(await exists(path.join(env.pctx.paths.dreamsDir, 'shadow')), false);
  assert.equal(env.pctx.state.snapshot().consecutiveFailures, 0);
});

test('Dream status reads the run manifest after the process forgets it', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    searchEvents: async () => ({ items: [] }),
    readEvent: async () => ({ events: [] }),
  };
  env.host.services.llm.stream = () => streamOf([{ type: 'text-delta', text: 'DONE' }, stop()]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-status-1' });
  assert.equal(result.skipped, true);
  const status = await env.runtime.dreamRun(env.pctx, 'run-status-1');
  // The agent ran and changed nothing: a finished run, not a skipped one.
  assert.equal(status.status, 'done');
  assert.equal(status.skipReason, 'nothing-new');
});

test('Dream uses the configured provider and model', async (t) => {
  const env = await toolsEnv(t, {
    autoDreamEnabled: false,
    dreamAnalyzerProvider: 'dream-prov',
    dreamAnalyzerModel: 'dream-model',
  });
  const calls = [];
  env.host.services.llm.stream = (options) => {
    calls.push(options);
    return streamOf([{ type: 'text-delta', text: 'DONE' }, stop()]);
  };
  await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-model-1' });
  assert.equal(calls[0].provider, 'dream-prov');
  assert.equal(calls[0].model, 'dream-model');
});

test('the legacy dreamAgent config toggle is gone', async () => {
  const { resolveConfig } = await loadModule('../src/config.js', { requireExports: ['resolveConfig'] });
  const config = resolveConfig({});
  assert.equal(Object.hasOwn(config, 'dreamAgent'), false);
});

test('memory_update refuses to overwrite a file changed since the read', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  await env.pctx.store.saveEntry({
    name: 'Style',
    type: 'feedback',
    description: 'Reply style',
    content: 'Be concise.',
    source: { via: 'test' },
  });
  const read = env.definitions.get('memory_read');
  const update = env.definitions.get('memory_update');
  const exec = { agent: { id: 's1' }, sessionId: 's1' };
  const first = await read.execute({ file: 'feedback_style.md' }, exec);
  assert.equal(first.ok, true);
  // A live edit between the model's read and its write.
  await env.pctx.store.updateEntry('feedback_style.md', { scope: 'project', content: 'Be very concise.' });
  const stale = await update.execute({ file: 'feedback_style.md', content: 'Be concise and warm.' }, exec);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'STALE');
  assert.equal((await env.pctx.store.readEntry('feedback_style.md')).body.trim(), 'Be very concise.');
});

test('a Dream run does not complete a session it never finished', async (t) => {
  const env = await toolsEnv(t, { autoDreamEnabled: false });
  env.host.services.sessionQuery = {
    filterSessions: async () => [{ header: { id: 's1', cwd: env.workspaceDir, createdAt: now - 1000 } }],
    listEvents: async () => [{ seq: 0 }, { seq: 1 }, { seq: 2 }],
    searchEvents: async () => ({ items: [] }),
    readEvent: async () => ({ events: [] }),
  };
  env.host.services.llm.stream = () => streamOf([
    toolCall('w1', 'memory_write', { file: 'project_note.md', name: 'Note', type: 'project', body: 'New note.' }),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
  const result = await env.runtime.dream({ pctx: env.pctx, force: true, trigger: 'manual', runId: 'run-partial-1' });
  assert.equal(result.ready, true);
  const processed = env.pctx.state.snapshot().dreamProcessedSessions.find((item) => item.id === 's1');
  assert.equal(processed, undefined, 'unread session must stay a candidate');
});
