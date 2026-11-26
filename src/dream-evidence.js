/**
 * Quote-backed checks for Dream.
 *
 * The diff view compares proposed bodies against stored ones, and quotes are
 * matched (`src/citation.js`) ignoring case, whitespace, markdown and
 * punctuation, so a real quote survives reformatting without turning the check
 * into a loose substring test.
 *
 * Dream itself checks only that a cited quote exists and who said it (see
 * `src/citation.js`); whether a note follows from its quote is the
 * model's call and the reviewer's.
 */

import { memoryHash } from './write-review.js';

/** Compare text ignoring case, whitespace, markdown and punctuation. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\\\s`*_#>|\-—:：,，.。;；!！?？()（）[\]{}"'“”‘’「」…/]+/g, '');
}

/** Content-line inventory, preserving indentation, duplicates and line numbers. */
export function bodyLineChanges(before, after) {
  const lines = value => String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const oldLines = lines(before);
  const newLines = lines(after);
  const unmatched = (source, target) => {
    const remaining = new Map();
    for (const text of target) remaining.set(text, (remaining.get(text) ?? 0) + 1);
    return source.flatMap((text, index) => {
      const count = remaining.get(text) ?? 0;
      if (count > 0) { remaining.set(text, count - 1); return []; }
      return text.trim() ? [{ line: index + 1, text }] : [];
    });
  };
  return { addedLines: unmatched(newLines, oldLines), removedLines: unmatched(oldLines, newLines) };
}

/**
 * What the reviewer applies is the exact shadow bytes of each changed page. A
 * page counts as sourced when at least one checked citation was recorded for it;
 * a changed page without one stays 'missing' and needs a direct confirmation.
 * A removed page whose facts moved elsewhere depends on the page they moved to.
 */
export async function citationProofs({ diff, shadowStore, links, evidence }) {
  const endOfMove = (file) => {
    const visited = new Set();
    while (Object.hasOwn(links, file)) {
      if (visited.has(file)) return null;
      visited.add(file);
      file = links[file];
    }
    return file;
  };
  const proofs = [];
  for (const { file, action } of diff.files) {
    const next = action === 'removed' ? null : await shadowStore.readEntry(file).catch((error) => {
      if (error?.code !== 'NOT_FOUND') throw error;
      return null;
    });
    const dest = action === 'removed' && Object.hasOwn(links, file) ? endOfMove(file) : null;
    proofs.push({
      file, action,
      revision: next ? memoryHash(next.raw) : 'removed',
      unsupportedClaims: [],
      kind: evidence.some((item) => item.file === file && item.verified === true) ? 'citation' : 'missing',
      ...(dest && dest !== file ? { dependsOn: dest } : {}),
    });
  }
  return proofs;
}
