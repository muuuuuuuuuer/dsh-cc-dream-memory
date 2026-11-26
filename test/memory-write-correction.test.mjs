/**
 * v21 P0-3: explicit corrections keep the current value active and the previous
 * value as a "Superseded: <old> (until <date>)" history line with source/session.
 * Engineering-note lines (APPLIES WHEN / VERIFY / OBSERVED / EXCEPTION) travel
 * with the current value instead of being overwritten or treated as superseded.
 *
 * Only a held citation of words the user wrote composes the trace; an update
 * without one (or with a legacy `basis`) writes the body verbatim.
 *
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { toolsEnv } from './v10-helpers.mjs';
import { currentBody, currentFactsInContext, isCurrentPage } from '../src/memory-body.js';

const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

test('memory_read keeps current text after a fenced history example', async (t) => {
  const env = await toolsEnv(t);
  const active = [
    'An example:', '~~~~markdown', '## History', 'STATUS: retired', '- Superseded: sample',
    '~~~', '```', '~~~~', '', 'The current identifier is TORCH-8746.',
  ].join('\n');
  const body = active + '\n\n## History\n\n- Superseded: TORCH-OLD';
  const file = 'project_template.md';
  await env.pctx.store.writeRawEntry(file, { name: 'Template', type: 'project', body });
  const read = await env.definitions.get('memory_read').execute({ file }, exec);
  assert.equal(read.body.trimEnd(), active);
  assert.equal(isCurrentPage(body), true);
  assert.match(currentBody(body), /TORCH-8746/u);
  assert.ok(currentFactsInContext(body).includes('The current identifier is TORCH-8746.'));
});

const ENGINEERING_NOTES = [
  'APPLIES WHEN: changing dependencies or lockfiles',
  'VERIFY: run pnpm install --frozen-lockfile',
  'OBSERVED: npm install rewrote the lockfile',
  'EXCEPTION: legacy packages still use npm',
];

function seededBody() {
  return ['Always use pnpm for dependency commands.', '', ...ENGINEERING_NOTES].join('\n');
}

function update(env) {
  return env.definitions.get('memory_update');
}

/** A cited write needs the quoted message in the session. */
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

function today() {
  return new Date().toISOString().slice(0, 10);
}

function supersededLines(body) {
  return String(body)
    .split('\n')
    .filter((line) => line.trim().startsWith('- Superseded:'));
}

test('v21 correction: explicit user correction activates the new value and keeps the old one with trace', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'package manager',
    type: 'project',
    description: 'how to install dependencies',
    content: seededBody(),
  });
  const before = today();
  seedUserMessages(env, 'Always use npm ci for dependency commands.');
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, content: 'Always use npm ci for dependency commands.', citations: [{ quote: 'Always use npm ci for dependency commands.' }] },
    exec,
  );
  const after = today();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.citations, [{ seq: 1, role: 'user' }]);
  assert.equal(result.correction.superseded, 'Always use pnpm for dependency commands.');
  assert.ok([before, after].includes(result.correction.until), `until is today: ${result.correction.until}`);
  assert.match(result.correction.source, /tool:memory_update/);
  assert.match(result.correction.source, /sess-1/);

  const entry = await env.pctx.store.readEntry(seed.file);
  const body = entry.body;
  assert.equal(body.split('\n')[0], 'STATUS: current', 'the corrected value is marked active');
  assert.match(body, /Always use npm ci for dependency commands\./);
  const historyIndex = body.indexOf('## History');
  assert.ok(historyIndex > 0, 'a history section exists');
  assert.ok(body.indexOf('Always use pnpm for dependency commands.') > historyIndex, 'the old value only survives in history');
  assert.doesNotMatch(body.slice(0, historyIndex), /Always use pnpm for dependency commands\./);

  const [line] = supersededLines(body);
  assert.ok(line, 'a Superseded history line exists');
  assert.match(
    line,
    new RegExp(`^- Superseded: Always use pnpm for dependency commands\\. \\(until ${result.correction.until}\\)`),
  );
  assert.match(line, /source: tool:memory_update, session sess-1/);
  assert.doesNotMatch(line, /APPLIES WHEN|VERIFY|OBSERVED|EXCEPTION/, 'notes describe the topic, not the superseded value');

  // Engineering notes stay attached to the current value.
  for (const note of ENGINEERING_NOTES) assert.ok(body.includes(note), `note survives: ${note}`);
  assert.equal((body.match(/APPLIES WHEN:/g) ?? []).length, 1, 'notes are not duplicated');

  // Frontmatter still records who wrote the current version, and the store's
  // overwrite history keeps the previous raw file too.
  assert.equal(entry.frontmatter.via, 'tool:memory_update');
  assert.equal(entry.frontmatter.source_session, 'sess-1');
  const snapshots = await readdir(path.join(env.pctx.paths.projectDir, '.history', seed.file));
  assert.ok(snapshots.length >= 1, 'the previous raw version is recoverable from .history');
});

test('v21 correction: a second explicit correction keeps both superseded values', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'package manager',
    type: 'project',
    description: 'how to install dependencies',
    content: seededBody(),
  });
  seedUserMessages(env, 'Always use npm ci for dependency commands.', 'Always use bun for dependency commands.');
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const first = await update(env).execute(
    { file: seed.file, content: 'Always use npm ci for dependency commands.', citations: [{ quote: 'Always use npm ci for dependency commands.' }] },
    exec,
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const second = await update(env).execute(
    { file: seed.file, content: 'Always use bun for dependency commands.', citations: [{ quote: 'Always use bun for dependency commands.' }] },
    exec,
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.correction.superseded, 'Always use npm ci for dependency commands.');

  const { body } = await env.pctx.store.readEntry(seed.file);
  const currentPart = body.slice(0, body.indexOf('## History'));
  assert.match(currentPart, /Always use bun for dependency commands\./);
  assert.doesNotMatch(currentPart, /Always use npm ci|Always use pnpm/);
  const lines = supersededLines(body);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines[0], /Always use npm ci for dependency commands\./, 'newest superseded value comes first');
  assert.match(lines[1], /Always use pnpm for dependency commands\./);
  assert.equal((body.match(/APPLIES WHEN:/g) ?? []).length, 1, 'carried notes are not duplicated');
  assert.equal((body.match(/STATUS: current/g) ?? []).length, 1);
});

test('v21 correction: new engineering notes replace the old note with the same label', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'package manager',
    type: 'project',
    description: 'how to install dependencies',
    content: seededBody(),
  });
  seedUserMessages(env, 'Always use npm ci for dependency commands.');
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    {
      file: seed.file,
      content: ['Always use npm ci for dependency commands.', '', 'VERIFY: run npm ci --ignore-scripts'].join('\n'),
      citations: [{ quote: 'Always use npm ci for dependency commands.' }],
    },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const { body } = await env.pctx.store.readEntry(seed.file);
  assert.equal((body.match(/VERIFY:/g) ?? []).length, 1, 'the new VERIFY replaces the old one');
  assert.match(body, /VERIFY: run npm ci --ignore-scripts/);
  assert.ok(body.includes(ENGINEERING_NOTES[0]), 'notes without a replacement label are carried forward');
});

test('v21 correction: an explicit correction writes the composed trace directly', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, '用户喜欢中文回复。');
  const seed = await env.pctx.store.saveEntry({
    name: 'language',
    type: 'user',
    description: 'reply language',
    content: '用户喜欢中文回复。',
  });
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, content: '用户喜欢英文回复。', citations: [{ quote: '用户喜欢中文回复。' }] },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.written, true);
  assert.equal(result.correction.superseded, '用户喜欢中文回复。');
  const { body } = await env.pctx.store.readEntry(seed.file);
  assert.match(body, /^STATUS: current/m);
  assert.match(body, /用户喜欢英文回复。/);
  assert.match(body, /- Superseded: 用户喜欢中文回复。 \(until \d{4}-\d{2}-\d{2}\)/);
});

test('v21 correction: an update without a citation writes the body verbatim', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'plain note',
    type: 'project',
    description: 'd',
    content: 'Old note body.',
  });
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute({ file: seed.file, content: 'New note body.' }, exec);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification, 'not-applicable');
  assert.equal(result.correction, undefined);
  const entry = await env.pctx.store.readEntry(seed.file);
  assert.equal(entry.body, 'New note body.', 'backward-compatible: no active/history markers are invented');
});

test('v21 correction: an assistant or pasted citation writes directly without the correction trace', async (t) => {
  const env = await toolsEnv(t);
  const pasted = ['# Release notes', '- 粘贴来的原话：用户讨厌中文回复。', '- b', '- c', '- d', '- e', '- f', '- g', '- h', '- i', '- j', '- k'].join('\n');
  const events = [
    { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '助手的看法：用户讨厌中文回复。' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${pasted}\n${'x'.repeat(900)}` }] } },
  ];
  env.host.services.sessionQuery = { filterSessions: async () => [], readSession: async (id) => ({ session: { id }, events }) };
  const seed = await env.pctx.store.saveEntry({
    name: 'language',
    type: 'user',
    description: 'reply language',
    content: 'STATUS: current\n用户喜欢中文回复。',
  });
  for (const [quote, role] of [['助手的看法：用户讨厌中文回复。', 'assistant'], ['粘贴来的原话：用户讨厌中文回复。', 'user-pasted']]) {
    await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
    const result = await update(env).execute(
      { file: seed.file, content: '用户讨厌中文回复。', citations: [{ quote }] },
      exec,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.written, true, JSON.stringify(result));
    assert.equal(result.citations[0].role, role);
    assert.equal(result.verification, 'not-applicable', 'only the user\'s own words verify');
    assert.equal(result.correction, undefined, 'only cited user words compose the trace');
    const { body } = await env.pctx.store.readEntry(seed.file);
    assert.equal(body, '用户讨厌中文回复。', 'the model-reported value replaces the body verbatim');
    assert.doesNotMatch(body, /STATUS: current|Superseded:/);
    await env.pctx.store.updateEntry(seed.file, { content: 'STATUS: current\n用户喜欢中文回复。' });
  }
});

test('v21 correction: a legacy basis is ignored and writes directly without correction markers', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'deployment',
    type: 'project',
    description: 'deploy command',
    content: 'Deploy with make release.',
  });
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, content: 'Deploy previews with make release-staging.', basis: 'forwarded' },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.basis, undefined);
  const { body } = await env.pctx.store.readEntry(seed.file);
  assert.equal(body, 'Deploy previews with make release-staging.');
  assert.doesNotMatch(body, /STATUS: current|Superseded:/, 'only explicit user corrections compose the trace');
});

test('v21 correction: earlier Dream-style inline Superseded lines are carried, not nested', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'route rule',
    type: 'project',
    description: 'route registration',
    content: [
      'STATUS: current',
      '- Register the route through the real entry point. ^[s1#7, 2026-11-01]',
      '- Superseded: Import the handler directly. (until 2026-11-01)',
      'APPLIES WHEN: changing route registration',
      'VERIFY: call the real entry point',
    ].join('\n'),
  });
  seedUserMessages(env, 'Register routes through the server entry point and verify them.');
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, content: 'Register routes through the server entry point and verify them.', citations: [{ quote: 'Register routes through the server entry point and verify them.' }] },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const { body } = await env.pctx.store.readEntry(seed.file);
  const lines = supersededLines(body);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines[0], /^- Superseded: Register the route through the real entry point\./);
  assert.doesNotMatch(lines[0], /^- Superseded: - /, 'bullet markers are not nested');
  assert.match(lines[1], /Import the handler directly\./, 'the Dream-written Superseded line is preserved');
  assert.ok(body.includes('APPLIES WHEN: changing route registration'));
  assert.ok(body.includes('VERIFY: call the real entry point'));
});

test('v21 correction: rename + explicit correction keeps the trace on the owning topic', async (t) => {
  const env = await toolsEnv(t);
  seedUserMessages(env, 'Use spaces for indentation.');
  const seed = await env.pctx.store.saveEntry({
    name: 'indent',
    type: 'user',
    description: 'indentation preference',
    content: 'Use tabs for indentation.',
  });
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, name: 'indentation rule', content: 'Use spaces for indentation.', citations: [{ quote: 'Use spaces for indentation.' }] },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const entries = await env.pctx.store.listEntries();
  assert.equal(entries.some((entry) => entry.name === 'indent'), false, 'the old topic file moved');
  const renamed = entries.find((entry) => entry.name === 'indentation rule');
  assert.ok(renamed, 'the renamed topic exists');
  const { body } = await env.pctx.store.readEntry(renamed.file);
  assert.match(body, /^STATUS: current/m);
  assert.match(body, /Use spaces for indentation\./);
  assert.match(body, /- Superseded: Use tabs for indentation\. \(until \d{4}-\d{2}-\d{2}\)/);
});

test('v21 correction: an unknown legacy basis is ignored, not an error', async (t) => {
  const env = await toolsEnv(t);
  const seed = await env.pctx.store.saveEntry({
    name: 'language',
    type: 'user',
    description: 'reply language',
    content: '用户喜欢中文回复。',
  });
  await env.definitions.get('memory_read').execute({ file: seed.file }, exec);
  const result = await update(env).execute(
    { file: seed.file, content: '用户讨厌中文回复。', basis: 'guessed' },
    exec,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await env.pctx.store.readEntry(seed.file)).body, '用户讨厌中文回复。');
});
