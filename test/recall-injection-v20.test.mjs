import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { isCurrentPage, stampVerification } from '../src/memory-body.js';
import { recordVerification, verifiedPage } from '../src/verification-ledger.js';
import { buildRecallText, recallNotes } from '../src/recall.js';
import { makeTempDir } from './helpers.mjs';

test('recall excludes superseded/stale notes and carries exceptions', () => {
  assert.equal(isCurrentPage('STATUS: current\nfact'), true);
  assert.equal(isCurrentPage('STATUS: superseded\nold'), false);
  assert.equal(isCurrentPage('STATUS: review-needed\nunverified'), false);
  assert.equal(isCurrentPage('STATUS: disputed'), false);
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

test('the host ledger vouches only for the exact content it recorded', async (t) => {
  const root = await makeTempDir(t);
  const entry = { file: 'a.md', name: 'A', description: 'first' };
  const body = 'STATUS: current\nfact';
  const store = { _scopeDir: () => root, _atomicWrite: (file, data) => writeFile(file, data, 'utf8') };
  await recordVerification({ store, scope: 'project', file: entry.file, name: entry.name, description: entry.description, body });
  assert.equal(await verifiedPage({ store, scope: 'project', entry, body }), true);
  // A hand-written stamp proves nothing; any edit voids the record until the host verifies it again.
  assert.equal(await verifiedPage({ store, scope: 'project', entry, body: stampVerification(`${body}\nedited`, '2026-11-11') }), false);
  assert.equal(await verifiedPage({ store, scope: 'project', entry: { ...entry, description: 'renamed' }, body }), false);
});
