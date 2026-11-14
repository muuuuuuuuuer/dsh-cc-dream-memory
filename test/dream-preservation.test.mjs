/**
 * Preservation guard: when a merge write is rejected, the deletes and index
 * rewrites that depended on it must go too — otherwise the plan destroys
 * content the surviving write never absorbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropDestructiveDependents } from '../src/dream-evidence.js';

const write = (file = 'feedback_evidence.md') => ({ op: 'write', scope: 'project', file, body: 'Show concrete evidence before claiming success.' });
const deletion = { op: 'delete', scope: 'project', file: 'feedback_uncertainty.md', reason: 'absorbed by feedback_evidence.md' };
const index = { op: 'index', scope: 'project', content: '- [Evidence](feedback_evidence.md) — Check results' };

test('a rejected merge write drops the deletes and index rewrites that depended on it', () => {
  const result = dropDestructiveDependents([write(), deletion, index], [deletion, index]);
  assert.deepEqual(result.operations, []);
  assert.equal(result.dropped.length, 2);
  assert.match(result.dropped.join(' '), /dropped dependency because a write was rejected/);
});

test('an accepted write keeps the destructive operations', () => {
  const result = dropDestructiveDependents([write(), deletion, index], [write(), deletion, index]);
  assert.deepEqual(result.operations, [write(), deletion, index]);
  assert.deepEqual(result.dropped, []);
});
