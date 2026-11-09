import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FROZEN_FILES,
  buildManifest,
  hashOf,
  normalize,
  readManifest,
  verifyFreeze,
} from '../scripts/ui-freeze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ui-freeze: the UI is frozen (manifest exists, policy recorded, hashes formatted)', () => {
  const manifest = readManifest();
  assert.ok(manifest, '.ui-freeze.json is required: the UI design is frozen');
  assert.equal(typeof manifest.frozenAt, 'string');
  assert.match(manifest.policy, /frozen/i, 'manifest must record the frozen policy');
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [...FROZEN_FILES].sort(),
    'manifest must cover exactly the frozen UI files',
  );
  for (const file of FROZEN_FILES) {
    assert.match(manifest.files[file], /^sha256:[0-9a-f]{64}$/, `${file} hash format`);
  }
});

test('ui-freeze: frozen UI files match the recorded hashes', () => {
  const result = verifyFreeze();
  assert.equal(result.missingManifest, false);
  assert.deepEqual(
    result.mismatches,
    [],
    `UI changed without an approved re-freeze: ${JSON.stringify(result.mismatches, null, 2)}`,
  );
  assert.equal(result.ok, true);
});

test('ui-freeze: re-freezing the current files reproduces the same hashes', () => {
  const current = buildManifest();
  const recorded = readManifest();
  for (const file of FROZEN_FILES) {
    assert.equal(current.files[file], recorded.files[file], `${file} hash stable`);
  }
});

test('ui-freeze: hashing is line-ending independent', () => {
  assert.equal(normalize('a\r\nb'), normalize('a\nb'));
  assert.equal(hashOf('client.js'), hashOf('client.js'));
});

test('ui-freeze: the documented approval workflow is present', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'UI-FREEZE.md'), 'utf8');
  assert.match(doc, /FROZEN/);
  assert.match(doc, /ui-freeze\.mjs --update/, 'unfreeze procedure must be documented');
  assert.match(doc, /explicit|明确批准|明确.*批准/, 'explicit approval requirement must be documented');
  assert.match(doc, /test\/ui-freeze\.test\.mjs/, 'guard test must be documented');
});
