import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Files that together decide what this install actually runs: the manifest, the
 * entry point, the panel bundle and the modules the panel's contract depends on.
 * A client can compare its own `uiApi` and this id with the Host's answer to see
 * whether the page and the backend came from the same package.
 */
const BUILD_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'src/status.js',
  'src/http.js',
  'src/inject.js',
  'src/dream-run.js',
];

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fileDigest(file) {
  try {
    const bytes = readFileSync(path.join(rootDir, file));
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
  } catch {
    return { file, bytes: 0, sha256: 'missing' };
  }
}

const files = BUILD_FILES.map(fileDigest);
const buildId = createHash('sha256')
  .update(files.map((item) => `${item.file}:${item.sha256}`).join('\n'))
  .digest('hex')
  .slice(0, 12);

let packageVersion = '';
try {
  packageVersion = String(JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version ?? '');
} catch {
  packageVersion = '';
}

/** Identity of the code this process loaded, plus the directory it came from. */
export function buildIdentity() {
  return {
    id: buildId,
    packageVersion,
    rootDir,
    files: files.length,
    digests: files.map(({ file, sha256 }) => `${file}:${sha256}`),
  };
}
