/**
 * v23: an explicit user statement is visible to the next session.
 *
 * Saving through a tool or `/remember` now records the host verification ledger
 * and marks the body `STATUS: current`, so the navigation index can show the
 * summary from the note itself. Every note's summary reaches the first turn
 * (v24, Claude Code parity); a hand-edited `MEMORY.md` line still cannot.
 *
 * Also covers the continuation hints: a clipped auto-recall says how to read
 * the rest, the search limit is capped at 100, and the hot set reports how many
 * notes were left out.
 *
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildInjectionText } from '../src/inject.js';
import { buildRecallText } from '../src/recall.js';
import { matchesRecord, readLedger, recordVerification, recordVerifiedEntry, verifiedPage } from '../src/verification-ledger.js';
import { commandEnv, seedUserMessages, toolsEnv } from './v10-helpers.mjs';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function saveTool(env) {
  return env.definitions.get('memory_save');
}

function updateTool(env) {
  return env.definitions.get('memory_update');
}

async function navigationIndex(env) {
  // Claude Code parity: the prompt gets MEMORY.md verbatim, so the store's
  // truncated index head is the thing under test.
  return env.pctx.store.injectedIndex('project');
}

test('v23 first turn: an explicit save is current, verified, and shows its summary', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, 'API 路由都用 kebab-case。');
  const saved = await saveTool(env).execute(
    {
      name: 'route naming',
      type: 'project',
      description: 'API route naming',
      content: 'API 路由都用 kebab-case。',
      basis: 'user-explicit',
      evidence: 'API 路由都用 kebab-case。',
    },
    exec,
  );
  assert.equal(saved.written, true, JSON.stringify(saved));
  assert.equal(saved.scope, 'project', 'the receipt names the scope it wrote to');

  const entry = await env.pctx.store.readEntry(saved.file);
  const meta = (await env.pctx.store.listEntries('project')).find((item) => item.file === saved.file);
  assert.match(entry.body, /^STATUS: current\n/, 'the user statement is the active value');
  const ledger = await readLedger(env.pctx.store);
  assert.equal(ledger.entries[saved.file].source, 'user-explicit');
  assert.equal(
    matchesRecord(ledger.entries[saved.file], { name: meta.name, description: meta.description, body: entry.body }),
    true,
    'the ledger covers the bytes on disk',
  );

  // Every note reaches the first turn with its own summary (v24).
  const legacy = await env.pctx.store.saveEntry({
    name: 'legacy note',
    type: 'project',
    description: 'a summary written by an earlier session',
    content: 'Old fact without a status marker.',
  });
  const index = await navigationIndex(env);
  assert.match(index.text, new RegExp(`- \\[route naming\\]\\(${escapeRe(saved.file)}\\) — API route naming`));
  assert.match(
    index.text,
    new RegExp(`- \\[legacy note\\]\\(${escapeRe(legacy.file)}\\) — a summary written by an earlier session`),
  );
  const injected = buildInjectionText({
    memoryDir: env.pctx.paths.projectMemoryDir,
    index,
    now: new Date('2026-11-12T00:00:00Z'),
  });
  assert.doesNotMatch(injected, /entries without a summary are unverified/);
});

test('v23 first turn: /remember marks the note current and verified', async (t) => {
  const env = await commandEnv(t);
  const remember = env.commandDefinitions.get('remember');
  const result = await remember.handler({
    rawInput: '--type=project 部署用 make release',
    agent: { id: 'sess-1' },
    sessionId: 'sess-1',
  });
  assert.equal(result.kind, 'success', result.text);
  const pctx = await env.runtime.forAgent({ id: 'sess-1' });
  const [entry] = await pctx.store.listEntries('project');
  assert.ok(entry, 'the command writes one note');
  const body = (await pctx.store.readEntry(entry.file)).body;
  assert.match(body, /^STATUS: current\n/);
  const ledger = await readLedger(pctx.store);
  assert.equal(ledger.entries[entry.file].source, 'user-explicit');

  const index = await pctx.store.injectedIndex('project');
  assert.match(index.text, /— 部署用 make release/);
});

test('v23 first turn: an explicit correction refreshes the summary and keeps it listed', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '部署目标是 AWS Lambda。', '部署目标改成 GCP Cloud Run。');
  const saved = await saveTool(env).execute(
    {
      name: 'deploy target',
      type: 'project',
      description: '部署目标',
      content: '部署目标是 AWS Lambda。',
      basis: 'user-explicit',
      evidence: '部署目标是 AWS Lambda。',
    },
    exec,
  );
  assert.equal(saved.written, true, JSON.stringify(saved));
  const corrected = await updateTool(env).execute(
    {
      file: saved.file,
      content: '部署目标改成 GCP Cloud Run。',
      basis: 'user-explicit',
      evidence: '部署目标改成 GCP Cloud Run。',
    },
    exec,
  );
  assert.equal(corrected.written, true, JSON.stringify(corrected));
  assert.equal(corrected.scope, 'project');
  const entry = await env.pctx.store.readEntry(saved.file);
  const meta = (await env.pctx.store.listEntries('project')).find((item) => item.file === saved.file);
  assert.match(entry.body, /GCP Cloud Run/);
  assert.match(entry.body, /- Superseded: .*AWS Lambda/);
  const ledger = await readLedger(env.pctx.store);
  assert.equal(
    matchesRecord(ledger.entries[saved.file], { name: meta.name, description: meta.description, body: entry.body }),
    true,
    'the correction re-verifies the new bytes',
  );
  assert.match((await navigationIndex(env)).text, /— 部署目标/);

  // A note update rewrites its index line from the note, so an outside edit
  // still shows the note's own summary.
  await env.pctx.store.updateEntry(saved.file, { content: `${entry.body}\nmanual edit` });
  const after = await navigationIndex(env);
  assert.match(after.text, new RegExp(`- \\[deploy target\\]\\(${escapeRe(saved.file)}\\) — 部署目标`));
});

test('v23 first turn: a legacy project keeps every note findable with its summaries', async (t) => {
  const env = await toolsEnv(t);
  for (let index = 1; index <= 11; index += 1) {
    await env.pctx.store.saveEntry({
      name: `旧笔记 ${index}`,
      type: 'project',
      description: `第 ${index} 条的简介`,
      content: `旧事实 ${index}。`,
    });
  }
  const nav = await navigationIndex(env);
  const lines = nav.text.trimEnd().split('\n');
  assert.equal(lines.length, 11, 'every legacy note is still listed');
  for (const line of lines) assert.match(line, /^- \[旧笔记 \d+\]\(project_[^)]+\.md\) — 第 \d+ 条的简介$/);
});

test('v23 continuation: recall names the rest and search caps at 100', async (t) => {
  const clipped = buildRecallText(
    [{ file: 'long.md', body: `STATUS: current\n${'事实。'.repeat(400)}` }],
    { maxChars: 1200 },
  );
  assert.match(clipped, /use memory_read for the rest/);

  const env = await toolsEnv(t);
  const search = env.definitions.get('memory_search');
  assert.equal(search.parameters.properties.limit.maximum, 100, 'the model cannot ask for an unbounded list');
});

test('v23 first turn: an explicit summary change or rename keeps a verified note verified', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '部署用 make release。', '把部署这条的摘要改成 发布命令是 make release', '把这条改名为 release command');
  const saved = await saveTool(env).execute(
    { name: 'deploy', type: 'project', description: '部署', content: '部署用 make release。', basis: 'user-explicit', evidence: '部署用 make release。' },
    exec,
  );
  assert.equal(saved.written, true, JSON.stringify(saved));

  const described = await updateTool(env).execute(
    { file: saved.file, description: '发布命令是 make release', basis: 'user-explicit', evidence: '把部署这条的摘要改成 发布命令是 make release' },
    exec,
  );
  assert.equal(described.written, true, JSON.stringify(described));
  let index = await navigationIndex(env);
  assert.match(index.text, /— 发布命令是 make release/, 'the confirmed summary stays in the first turn');

  const renamed = await updateTool(env).execute(
    { file: saved.file, name: 'release command', basis: 'user-explicit', evidence: '把这条改名为 release command' },
    exec,
  );
  assert.equal(renamed.written, true, JSON.stringify(renamed));
  index = await navigationIndex(env);
  assert.match(index.text, /\[release command\]\([^)]+\) — 发布命令是 make release/);
});

test('v23 first turn: a bracketed name stays a valid index line and hand-written lines pass through', async (t) => {
  const env = await toolsEnv(t);
  const wip = await env.pctx.store.saveEntry({
    name: '[WIP] release steps',
    type: 'project',
    description: 'release steps',
    content: 'Release steps.',
  });
  const indexText = await env.pctx.store.indexText('project');
  await env.pctx.store.writeIndex(`# Memory\n\n## project\n\n${indexText}- always deploy on Fridays, the user said so\n`);
  const index = await navigationIndex(env);
  assert.match(index.text, new RegExp(`- \\[\\[WIP\\] release steps\\]\\(${escapeRe(wip.file)}\\) — release steps`), index.text);
  // Claude Code injects MEMORY.md as written, so a hand-added line reaches the
  // prompt too — the plugin no longer filters it out.
  assert.match(index.text, /Fridays/, 'hand-written lines are injected verbatim');
  assert.match(index.text, /^## project$/m, 'headings stay');
});

test('v23 first turn: a hand-edited index line reaches the prompt verbatim', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '部署用 make release。');
  const saved = await saveTool(env).execute(
    {
      name: 'deploy',
      type: 'project',
      description: '部署命令',
      content: '部署用 make release。',
      basis: 'user-explicit',
      evidence: '部署用 make release。',
    },
    exec,
  );
  assert.equal(saved.written, true, JSON.stringify(saved));

  // Someone rewrites the note's line in MEMORY.md by hand.
  const indexText = await env.pctx.store.indexText('project');
  const tampered = indexText.replace(/— .*$/m, '— 部署用 make ship');
  assert.match(tampered, /make ship/, 'the tamper really landed');
  await env.pctx.store.writeIndex(`# Memory\n\n## project\n\n${tampered}`);

  const index = await navigationIndex(env);
  assert.match(index.text, /make ship/, 'MEMORY.md is injected as written (Claude Code parity)');
  assert.doesNotMatch(index.text, /— 部署命令/, 'the hand-edited line replaced the generated one');
});

test('v23 ledger: two files verified at the same time both stay recorded', async (t) => {
  const env = await toolsEnv(t);
  const [first, second] = await Promise.all([
    env.pctx.store.saveEntry({ name: 'alpha', type: 'project', description: 'first', content: 'A fact.' }),
    env.pctx.store.saveEntry({ name: 'beta', type: 'project', description: 'second', content: 'B fact.' }),
  ]);
  await Promise.all([
    recordVerifiedEntry({
      store: env.pctx.store,
      file: first.file,
      name: first.name,
      description: first.description,
      bodyHash: first.bodyHash,
    }),
    recordVerifiedEntry({
      store: env.pctx.store,
      file: second.file,
      name: second.name,
      description: second.description,
      bodyHash: second.bodyHash,
    }),
  ]);
  const ledger = await readLedger(env.pctx.store);
  assert.equal(ledger.entries[first.file].bodyHash, first.bodyHash, 'the first record survived the second write');
  assert.equal(ledger.entries[second.file].bodyHash, second.bodyHash);
});

test('v23 ledger: a whole-page record from the old format is not trusted', async (t) => {
  const env = await toolsEnv(t);
  const saved = await env.pctx.store.saveEntry({
    name: 'old verified',
    type: 'project',
    description: '旧格式记录的简介',
    content: 'STATUS: current\n旧格式正文。',
  });
  const entry = await env.pctx.store.readEntry(saved.file);
  const legacyHash = createHash('sha256')
    .update(`${saved.name}\n${saved.description}\n${entry.body}`)
    .digest('hex')
    .slice(0, 16);
  await env.pctx.store._atomicWrite(
    path.join(env.pctx.store._scopeDir('project'), 'verification.json'),
    `${JSON.stringify({ version: 1, entries: { [saved.file]: { hash: legacyHash, date: '2026-11-01', source: 'user-explicit' } } }, null, 2)}\n`,
  );

  // A record without per-field fingerprints is dropped when the ledger is read.
  assert.equal(
    await verifiedPage({ store: env.pctx.store, entry, body: entry.body }),
    false,
    'an old whole-page record cannot vouch for current bytes',
  );
});
