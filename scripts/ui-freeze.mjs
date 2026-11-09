#!/usr/bin/env node
/**
 * UI design freeze guard.
 *
 * The Memory UI is frozen by maintainer decision (2026-11-07). This script
 * hashes the frozen UI files (client.js, locale dictionaries, icon) and compares
 * them with `.ui-freeze.json`. Any UI change that was not explicitly approved
 * and re-frozen makes this check (and test/ui-freeze.test.mjs) fail.
 *
 * Usage:
 *   node scripts/ui-freeze.mjs           # verify (CI/tests)
 *   node scripts/ui-freeze.mjs --update  # re-freeze AFTER explicit maintainer approval
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_NAME = '.ui-freeze.json';
const MANIFEST_PATH = path.join(ROOT, MANIFEST_NAME);

/** Files covered by the UI freeze. */
export const FROZEN_FILES = Object.freeze([
  'client.js',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]);

/** Normalize line endings and BOM so the hash is stable across checkouts/OS. */
export function normalize(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** @returns {string} `sha256:<hex>` for one repo-relative file. */
export function hashOf(relativePath) {
  const text = normalize(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/** Build the manifest object from the current files. */
export function buildManifest() {
  const files = {};
  for (const file of FROZEN_FILES) files[file] = hashOf(file);
  return {
    frozenAt: new Date().toISOString(),
    policy:
      'UI design is FROZEN by maintainer decision (2026-11-07). Do not modify client.js, locale/*.json or icon.svg without explicit user approval; then run `node scripts/ui-freeze.mjs --update` and commit with a `UI-FREEZE:` reason.',
    files,
  };
}

/** @returns {object|null} parsed manifest, or null when absent/unreadable. */
export function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compare current UI files against the manifest.
 * @returns {{ok:boolean, missingManifest:boolean, mismatches:Array<{file:string,expected:string,actual:string}>}}
 */
export function verifyFreeze() {
  const manifest = readManifest();
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.files !== 'object') {
    return { ok: false, missingManifest: true, mismatches: [] };
  }
  const mismatches = [];
  for (const file of FROZEN_FILES) {
    const expected = manifest.files[file];
    const actual = hashOf(file);
    if (expected !== actual) mismatches.push({ file, expected, actual });
  }
  const unexpected = Object.keys(manifest.files).filter((file) => !FROZEN_FILES.includes(file));
  for (const file of unexpected) mismatches.push({ file, expected: manifest.files[file], actual: 'not a frozen file' });
  return { ok: mismatches.length === 0, missingManifest: false, mismatches, manifest };
}

function main() {
  const update = process.argv.includes('--update');
  if (update) {
    const manifest = buildManifest();
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`[ui-freeze] re-frozen ${Object.keys(manifest.files).length} files`);
    for (const [file, hash] of Object.entries(manifest.files)) console.log(`  ${file} ${hash}`);
    console.log('[ui-freeze] commit with a `UI-FREEZE:` reason and explicit maintainer approval.');
    return 0;
  }
  const result = verifyFreeze();
  if (result.missingManifest) {
    console.error('[ui-freeze] FAILED: .ui-freeze.json is missing. The UI is frozen; restore it or re-freeze with --update after explicit approval.');
    return 1;
  }
  if (!result.ok) {
    console.error('[ui-freeze] FAILED: frozen UI files changed without an approved re-freeze:');
    for (const item of result.mismatches) {
      console.error(`  ${item.file}\n    expected ${item.expected}\n    actual   ${item.actual}`);
    }
    console.error('[ui-freeze] The Memory UI is FROZEN by user decision. Obtain explicit approval, then run `node scripts/ui-freeze.mjs --update`.');
    return 1;
  }
  console.log(`[ui-freeze] PASS: ${FROZEN_FILES.length} frozen UI files match .ui-freeze.json`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
