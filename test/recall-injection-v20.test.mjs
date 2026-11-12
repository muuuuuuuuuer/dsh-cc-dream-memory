import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildInjectionText, buildHotIndex, hotEligible, memoryStatusIsCurrent } from '../src/inject.js';
import { stampVerification } from '../src/memory-body.js';
import { recordVerification, verifiedPage } from '../src/verification-ledger.js';
import { buildRecallText, recallIsCurrent, recallNotes } from '../src/recall.js';
import { makeTempDir } from './helpers.mjs';

test('recall excludes superseded/stale notes and carries exceptions', () => {
  assert.equal(recallIsCurrent('STATUS: current\nfact'), true);
  assert.equal(recallIsCurrent('STATUS: superseded\nold'), false);
  assert.equal(recallIsCurrent('STATUS: review-needed\nunverified'), false);
  assert.equal(memoryStatusIsCurrent('STATUS: disputed'), false);
  const notes = recallNotes([
    'APPLIES WHEN: changing a route registration',
    'VERIFY: hit the real entry point',
    'OBSERVED: a default value looked fine but the route was not registered',
    'EXCEPTION: a trailing slash is legal',
  ].join('\n'));
  assert.match(notes.appliesWhen, /route/);
  assert.match(notes.verify, /entry point/);
  assert.match(notes.exception, /trailing slash/);
  const text = buildRecallText([
    { file: 'feedback_route.md', body: 'STATUS: current\n- Rule. ^[s1#1]\nEXCEPTION: trailing slash is legal' },
    { file: 'feedback_old.md', body: 'STATUS: superseded\n- Old rule.' },
  ], { maxChars: 2000 });
  assert.match(text, /feedback_route/);
  assert.doesNotMatch(text, /feedback_old/);
  assert.match(text, /Exception: trailing slash is legal/);
  assert.match(text, /Superseded, stale and disputed notes are excluded/);
});

test('hot eligibility needs current status, and only the host ledger promotes a page', () => {
  // Status is the cheap half of the decision; the ledger is the expensive half.
  assert.equal(hotEligible('STATUS: current\nfact'), true);
  // A hand-typed date proves nothing, so it is not what grants eligibility: the
  // page below is only promoted when the host holds a record (see next test).
  assert.equal(hotEligible('STATUS: current\nVERIFIED: 2026-11-11\nfact'), true);
  assert.equal(hotEligible('STATUS: superseded\nfact'), false);
  assert.equal(hotEligible('no markers'), false);
});

test('hot index promotes only the pages the host verified for this exact content', async (t) => {
  const root = await makeTempDir(t);
  const entries = [
    { file: 'a.md', name: 'A', description: 'first', modified: '2026-11-11T10:00:00.000Z' },
    { file: 'b.md', name: 'B', description: 'second', modified: '2026-11-10T10:00:00.000Z' },
    { file: 'c.md', name: 'C', description: 'third', modified: '2026-11-09T10:00:00.000Z' },
    { file: 'unmarked.md', name: 'Unmarked', description: 'never verified', modified: '2026-11-12T10:00:00.000Z' },
    { file: 'old.md', name: 'Old', description: 'stale', modified: '2026-11-08T10:00:00.000Z' },
  ];
  const bodies = new Map([
    ['a.md', 'STATUS: current\nfact'],
    ['b.md', 'STATUS: current\nfact'],
    // c.md carries a perfectly valid hand-written stamp, which is exactly why it
    // must not be promoted: the caller can compute the hash itself.
    ['c.md', stampVerification('STATUS: current\nself stamped', '2026-11-11')],
    ['unmarked.md', 'no status and no verification'],
    ['old.md', 'STATUS: superseded\nold'],
  ]);
  const store = {
    rootDir: root,
    _scopeDir: () => root,
    listEntries: async () => entries,
    readEntry: async (file) => ({ ...entries.find((entry) => entry.file === file), body: bodies.get(file) }),
  };
  for (const file of ['a.md', 'b.md']) {
    const entry = entries.find((item) => item.file === file);
    await recordVerification({ store, scope: 'project', file, name: entry.name, description: entry.description, body: bodies.get(file) });
  }
  const hot = await buildHotIndex({
    store,
    paths: { metricsFile: path.join(root, 'missing-metrics.json') },
    limit: 3,
  });
  assert.equal(hot.lines, 2);
  assert.equal(hot.omitted, 3);
  assert.match(hot.text, /a\.md/);
  assert.match(hot.text, /b\.md/);
  assert.doesNotMatch(hot.text, /c\.md|old\.md|unmarked\.md/);
  // Editing a verified page voids its record until the host verifies it again.
  assert.equal(await verifiedPage({ store, scope: 'project', entry: entries[0], body: `${bodies.get('a.md')}\nedited` }), false);
  assert.equal(await verifiedPage({ store, scope: 'project', entry: { ...entries[0], description: 'renamed' }, body: bodies.get('a.md') }), false);
  const text = buildInjectionText({
    memoryDir: root,
    config: {},
    index: { ...hot, text: hot.text, totalLines: 4, totalBytes: 100, maxLines: 200, maxBytes: 25600 },
  });
  assert.match(text, /<index>/);
  assert.match(text, /<hot-set>/);
  assert.match(text, /more topic\(s\)/);
});
