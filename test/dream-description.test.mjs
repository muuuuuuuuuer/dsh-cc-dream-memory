/**
 * A rewritten description is a retrieval change, not a knowledge change: the
 * facts stay put, so no citation can exist for the rewording. It must reach the
 * reviewer as its own kind, and a description edited in the same write as a
 * fact change must still carry a source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProofs } from '../src/dream-evidence.js';

const page = (file, description, body) => ({
  file,
  raw: `---\nname: ${file}\ndescription: ${description}\ntype: feedback\n---\n\n${body}\n`,
  body,
  frontmatter: { name: file, description, type: 'feedback' },
});
const storeWith = (entries) => ({ readEntry: async (file) => entries.get(file) ?? null });
const diffOf = (file) => ({ files: [{ file, action: 'changed' }] });

const file = 'feedback_evidence.md';
const first = 'Show the failing output before claiming a fix.';
const second = 'Name the command that reproduced it.';
const proofFor = (prior, next) => reviewProofs({
  diff: diffOf(file),
  store: storeWith(new Map([[file, prior]])),
  shadowStore: storeWith(new Map([[file, next]])),
  links: {},
  evidence: [],
}).then((proofs) => proofs[0]);

test('a rewritten description over unchanged facts is its own kind', async () => {
  const proof = await proofFor(
    page(file, 'How to report results', first),
    page(file, 'How to report test results and failures', first),
  );
  assert.equal(proof.kind, 'description');
});

test('an unchanged description over unchanged facts stays preserved', async () => {
  const proof = await proofFor(
    page(file, 'How to report results', `${first}\n${second}`),
    page(file, 'How to report results', `${second}\n${first}`),
  );
  assert.equal(proof.kind, 'preserved');
});

test('a description rewrite that drops a fact still needs a source', async () => {
  const proof = await proofFor(
    page(file, 'How to report results', `${first}\n${second}`),
    page(file, 'How to report test results', first),
  );
  assert.equal(proof.kind, 'missing');
});

test('a description rewrite that adds a fact still needs a source', async () => {
  const proof = await proofFor(
    page(file, 'How to report results', first),
    page(file, 'How to report test results', `${first}\n${second}`),
  );
  assert.equal(proof.kind, 'missing');
});
