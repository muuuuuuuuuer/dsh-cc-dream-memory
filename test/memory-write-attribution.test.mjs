/**
 * v21 P0-3: attribution basis for online memory writes.
 *
 * Only `basis:'user-explicit'` may create/update an active user/feedback/
 * preference claim. `forwarded` and `inference` proposals are queued in the
 * existing pending-write review (even with `force:true`), including a `project`
 * page whose body says "用户要求". An omitted basis keeps the legacy direct
 * write path so the existing model-tool behavior and tests do not regress; the
 * only omitted-basis ambiguity guards are relayed material and a non-profile
 * page asserting a user requirement.
 *
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

/** Seed the host transcript so a `user-explicit` basis has something to verify. */
function seedUserMessages(env, ...texts) {
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({
      session: { id },
      events: texts.map((text, index) => ({
        type: 'user/message',
        seq: index + 1,
        time: Date.parse('2026-11-11T09:00:00Z') + index,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
      })),
    }),
  };
}

function save(env) {
  return env.definitions.get('memory_save');
}

async function entriesOf(env, scope) {
  return env.pctx.store.listEntries(scope);
}

test('v22 basis: an omitted basis on a profile page queues instead of writing', async (t) => {
  const env = await toolsEnv(t);
  const queued = await save(env).execute(
    { name: 'brevity', type: 'user', description: 'reply style', content: '用户要求回答简短。' },
    exec,
  );
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.written, false, JSON.stringify(queued));
  assert.equal(queued.action, 'queued-review', JSON.stringify(queued));
  assert.equal(queued.basis, 'legacy');
  assert.match(queued.reasons.join(' '), /no basis: a write to a user\/feedback page/);
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 1);

  // Ordinary project notes keep the legacy direct write.
  const legacy = await save(env).execute(
    { name: 'build command', type: 'project', description: 'how to build', content: 'Run npm run build before npm test.' },
    exec,
  );
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.written, true, JSON.stringify(legacy));
  assert.equal(legacy.basis, 'legacy');
});

test('v22 basis: user-explicit writes only when the host verified the user message', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '用户要求回答尽量简短。');
  const result = await save(env).execute(
    {
      name: 'brevity explicit',
      type: 'user',
      description: 'reply style confirmed by the user',
      content: '用户要求回答尽量简短。',
      basis: 'user-explicit',
      evidence: '用户要求回答尽量简短。',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, true, JSON.stringify(result));
  assert.equal(result.basis, 'user-explicit');
  const entry = await env.pctx.store.readEntry(result.file);
  assert.match(entry.body, /用户要求回答尽量简短/);
  assert.equal(entry.frontmatter.via, 'tool:memory_save');
  assert.equal(entry.frontmatter.source_session, 'sess-1');
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 0);
});

test('v21 basis: a forwarded user claim is queued and force cannot bypass it', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    {
      name: 'forwarded preference',
      type: 'user',
      description: 'relayed requirement',
      content: '转发材料说用户要求所有回答先给结论。',
      basis: 'forwarded',
      force: true,
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review');
  assert.equal(typeof result.pendingId, 'string');
  assert.equal(result.basis, 'forwarded');
  assert.match(JSON.stringify(result.reasons), /forwarded/i);
  assert.deepEqual(await entriesOf(env, 'project'), [], 'the claim never becomes active memory');
  const pending = await env.mods.pending.listPendingWrites(env.pctx.paths);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].source.basis, 'forwarded', 'the review queue records the claimed authority');
});

test('v21 basis: an inferred claim in a project page body queues as well', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    {
      name: 'handoff rules',
      type: 'project',
      description: 'handoff notes',
      content: '用户要求所有提交先写测试。',
      basis: 'inference',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review');
  assert.match(JSON.stringify(result.reasons), /inference/i);
  assert.deepEqual(await entriesOf(env, 'project'), []);
});

test('v21 basis: a forwarded engineering note without user attribution writes directly', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    {
      name: 'route verification',
      type: 'project',
      description: 'forwarded CI report about route registration',
      content: 'Route registration must be verified through the real entry point, not only the handler.',
      basis: 'forwarded',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, true, JSON.stringify(result));
  assert.equal(result.basis, 'forwarded');
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 0);
});

test('v21 basis: an omitted basis on a project page asserting a user requirement queues', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    {
      name: 'ambiguous attribution',
      type: 'project',
      description: 'handoff note',
      content: '用户要求交接文档先写结论。',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review', JSON.stringify(result));
  assert.match(JSON.stringify(result.reasons), /non-user page|explicit basis/i);
  assert.deepEqual(await entriesOf(env, 'project'), []);
});

test('v21 basis: relayed wording without a basis is ambiguous and queues', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    { name: 'relayed', type: 'user', description: 'pasted report', content: '转发材料：用户要求所有回答先给结论。' },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review');
  assert.match(JSON.stringify(result.reasons), /relayed material/i);
});

test('v21 basis: an unknown basis is rejected instead of silently gaining authority', async (t) => {
  const env = await toolsEnv(t);
  const result = await save(env).execute(
    { name: 'typo basis', type: 'user', content: '用户要求回答简短。', basis: 'user_explicit' },
    exec,
  );
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, 'INVALID_ARGUMENT');
  assert.deepEqual(await entriesOf(env, 'project'), []);
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 0);
});

test('v21 basis: English user attribution inside a project page also counts as a claim', async (t) => {
  const env = await toolsEnv(t);
  const forwarded = await save(env).execute(
    {
      name: 'reply style',
      type: 'project',
      description: 'handoff',
      content: 'The user prefers short answers.',
      basis: 'forwarded',
    },
    exec,
  );
  assert.equal(forwarded.action, 'queued-review', JSON.stringify(forwarded));
  assert.equal((await entriesOf(env, 'project')).length, 0);

  const inferred = await save(env).execute(
    { name: 'reply style 2', type: 'project', description: 'handoff', content: 'user wants concise replies.', basis: 'inference' },
    exec,
  );
  assert.equal(inferred.action, 'queued-review', JSON.stringify(inferred));
  assert.equal((await entriesOf(env, 'project')).length, 0);
});

test('v21 basis: forwarded report + explicit adoption records only the adopted item', async (t) => {
  const env = await toolsEnv(t);
  // 1) A forwarded handoff report contains two "用户要求" items. Neither may
  //    become an active preference just because it was relayed.
  const report = await save(env).execute(
    {
      name: 'handoff report',
      type: 'project',
      description: 'forwarded handoff report',
      content: '转发材料：用户要求回答简短。用户要求所有提交先写测试。',
      basis: 'forwarded',
      force: true,
    },
    exec,
  );
  assert.equal(report.action, 'queued-review', JSON.stringify(report));
  assert.equal(report.written, false);
  assert.equal((await entriesOf(env, 'project')).length, 0);

  // 2) The user explicitly adopts exactly one item, and the host can see it.
  seedUserMessages(env, '好，以后回答简短。');
  const adopted = await save(env).execute(
    {
      name: 'reply brevity',
      type: 'user',
      description: 'user-confirmed reply style',
      content: '用户要求回答简短。',
      basis: 'user-explicit',
      evidence: '以后回答简短。',
    },
    exec,
  );
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.equal(adopted.written, true, JSON.stringify(adopted));

  // 3) Only the adopted item is active; the forwarded report stays pending.
  const active = await entriesOf(env, 'project');
  assert.equal(active.length, 1, JSON.stringify(active));
  assert.equal(active[0].name, 'reply brevity');
  const body = (await env.pctx.store.readEntry(active[0].file)).body;
  assert.match(body, /用户要求回答简短/);
  assert.doesNotMatch(body, /先写测试/, 'the un-adopted item is not part of active memory');
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 1, 'the forwarded proposal is still awaiting review');
});

test('v22 basis: user-explicit without a verifiable user message queues the claim', async (t) => {
  const env = await toolsEnv(t);
  // Repro: the model self-reports user-explicit and the call carries no quote.
  const bare = await save(env).execute(
    { name: 'silent approval', type: 'user', description: 'reply style', content: '用户要求回答简短。', basis: 'user-explicit' },
    exec,
  );
  assert.equal(bare.ok, true, JSON.stringify(bare));
  assert.equal(bare.written, false, JSON.stringify(bare));
  assert.equal(bare.action, 'queued-review', JSON.stringify(bare));
  assert.match(JSON.stringify(bare.reasons), /could not verify a verbatim user message/i);
  assert.equal((await entriesOf(env, 'project')).length, 0, 'the unverified claim never becomes active memory');
  assert.equal((await env.mods.pending.listPendingWrites(env.pctx.paths)).length, 1);

  // A quote the transcript does not contain is rejected the same way.
  seedUserMessages(env, '请继续。');
  const invented = await save(env).execute(
    { name: 'invented approval', type: 'user', description: 'reply style', content: '用户要求回答简短。', basis: 'user-explicit', evidence: '用户要求回答简短。' },
    exec,
  );
  assert.equal(invented.written, false, JSON.stringify(invented));
  assert.equal(invented.action, 'queued-review');
  assert.match(String(invented.evidenceCheck), /not a verbatim user message/);
  assert.equal((await entriesOf(env, 'project')).length, 0);

  // Ordinary engineering notes keep the legacy behavior even with the basis.
  const note = await save(env).execute(
    { name: 'route check', type: 'project', description: 'CI note', content: 'Route registration must be verified through the real entry point.', basis: 'user-explicit' },
    exec,
  );
  assert.equal(note.written, true, JSON.stringify(note));
  assert.equal(note.basis, 'user-explicit');
});

test('v22 basis: memory_update needs the same verified user message', async (t) => {
  const env = await toolsEnv(t);
  const update = env.definitions.get('memory_update');
  seedUserMessages(env, '用户要求回答简短。');
  const created = await save(env).execute(
    { name: 'brevity', type: 'user', description: 'reply style', content: '用户要求回答简短。', basis: 'user-explicit', evidence: '用户要求回答简短。' },
    exec,
  );
  assert.equal(created.written, true, JSON.stringify(created));
  const queued = await update.execute({ file: created.file, content: '用户要求回答极简。', basis: 'user-explicit' }, exec);
  assert.equal(queued.written, false, JSON.stringify(queued));
  assert.equal(queued.action, 'queued-review', JSON.stringify(queued));
  assert.match((await env.pctx.store.readEntry(created.file)).body, /回答简短/, 'the unverified correction never lands');

  seedUserMessages(env, '记住这条：用户要求回答极简。');
  const applied = await update.execute(
    { file: created.file, content: '用户要求回答极简。', basis: 'user-explicit', evidence: '记住这条：用户要求回答极简。' },
    exec,
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.written, true, JSON.stringify(applied));
  const body = (await env.pctx.store.readEntry(created.file)).body;
  assert.match(body, /回答极简/);
  assert.match(body, /Superseded: 用户要求回答简短。/, 'the corrected value stays auditable');
});

test('v22 basis: a located quote that never asked for the claim still queues', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, 'Please continue.');
  const result = await save(env).execute(
    {
      name: 'language',
      type: 'user',
      description: 'reply language',
      content: 'Always answer in German.',
      basis: 'user-explicit',
      evidence: 'Please continue.',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review', JSON.stringify(result));
  assert.match(String(result.evidenceCheck), /does not contain the claim being written/);
  assert.equal((await env.pctx.store.listEntries('user')).length, 0, 'nothing reached the user page');
});

test('v23 basis: evidence that says the opposite cannot authorize the claim', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, 'Never answer in German.');
  const result = await save(env).execute(
    {
      name: 'reply language',
      type: 'user',
      description: 'reply language',
      content: 'Always answer in German.',
      basis: 'user-explicit',
      evidence: 'Never answer in German.',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review', JSON.stringify(result));
  assert.match(String(result.evidenceCheck), /does not contain the claim being written/);
  assert.equal((await env.pctx.store.listEntries('user')).length, 0, 'the opposite instruction must not be stored');
});

test('v23 basis: swapped quantities cannot authorize the proposal', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, 'Read timeout is 15 seconds, write timeout is 90 seconds.');
  const result = await save(env).execute(
    {
      name: 'timeouts',
      type: 'user',
      description: 'timeouts',
      content: '- Read timeout is 90 seconds, write timeout is 15 seconds.',
      basis: 'user-explicit',
      evidence: 'Read timeout is 15 seconds, write timeout is 90 seconds.',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review', JSON.stringify(result));
  assert.match(String(result.evidenceCheck), /does not contain the claim being written/);
});

test('v23 basis: dropping half of a condition cannot authorize the proposal', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '客户和负责人都同意时才用 YAML。');
  const result = await save(env).execute(
    {
      name: 'yaml policy',
      type: 'user',
      description: 'yaml policy',
      content: '- 客户同意时才用 YAML。',
      basis: 'user-explicit',
      evidence: '客户和负责人都同意时才用 YAML。',
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, false, JSON.stringify(result));
  assert.equal(result.action, 'queued-review', JSON.stringify(result));
  assert.match(String(result.evidenceCheck), /does not contain the claim being written/);
});