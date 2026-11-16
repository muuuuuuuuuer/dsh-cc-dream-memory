/**
 * Text-matching helpers for quote-backed memory checks.
 *
 * The user-evidence check (`src/user-evidence.js`) locates the quote a claim
 * cites in what the model actually read, and the diff view compares proposed
 * bodies against stored ones. Matching ignores case, whitespace, markdown and
 * punctuation, so a real quote survives reformatting without turning the check
 * into a loose substring test.
 */

import { currentBody, currentFactsInContext, memoryStatusOf } from './memory-body.js';
import { memoryHash } from './write-review.js';

/** Below this many significant characters a quote proves nothing. */
const MIN_QUOTE_CHARS = 6;
const TRANSCRIPT_TAG = /^\[(user|user-pasted|assistant|tool-call|tool-result|tool-error)\] ?/;
const DATE_MARKER = /^--- (\d{4}-\d{2}-\d{2}) ---$/;

/** Compare text ignoring case, whitespace, markdown and punctuation. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\\\s`*_#>|\-—:：,，.。;；!！?？()（）[\]{}"'“”‘’「」…/]+/g, '');
}

/**
 * Split a rendered transcript back into blocks.
 * @param {string} text transcript from `chunkTranscript`.
 * @returns {Array<{tag:string, date:string, text:string}>} `text` is normalized.
 */
export function parseTranscriptBlocks(text) {
  const blocks = [];
  let date = '';
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const marker = line.match(DATE_MARKER);
    if (marker) {
      date = marker[1];
      continue;
    }
    const tag = line.match(TRANSCRIPT_TAG);
    if (tag) {
      current = { tag: tag[1], date, raw: line.slice(tag[0].length) };
      blocks.push(current);
    } else if (current) {
      current.raw += `\n${line}`;
    }
  }
  return blocks.map((block) => ({ tag: block.tag, date: block.date, text: normalizeForMatch(block.raw) }));
}

/** The first block containing a quote, so its true source and date can be used. */
export function locateQuote(quote, blocks) {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return blocks.find((block) => block.text.includes(needle)) ?? null;
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

/** Bind the apply decision to the exact shadow bytes the reviewer can inspect. */
export async function reviewProofs({ diff, store, shadowStore, links, evidence }) {
  const before = async (file) => store.readEntry(file).catch((error) => {
    if (error?.code !== 'NOT_FOUND') throw error;
    return null;
  });
  const after = async (file) => shadowStore.readEntry(file).catch((error) => {
    if (error?.code !== 'NOT_FOUND') throw error;
    return null;
  });
  // Facts are compared with the headings above them: renaming "Likes" to
  // "Dislikes" changes every line below it even when those lines are equal.
  const facts = (entry) => currentFactsInContext(entry?.body);
  const contains = (all, subset) => subset.every((line) => all.includes(line));
  const endOfMove = (file) => {
    const visited = new Set();
    while (Object.hasOwn(links, file)) {
      if (visited.has(file)) return null;
      visited.add(file);
      file = links[file];
    }
    return file;
  };
  // A page quote must still be in the current text of that page in the copy
  // being applied, so a change cannot rest on a page it also removes or rewrites.
  const pageStillSays = async (item) => {
    if (item.source !== 'memory') return true;
    const page = await after(item.memoryFile);
    if (!page || page.file === item.file) return false;
    const wanted = normalizeForMatch(item.quote);
    return wanted.length >= MIN_QUOTE_CHARS && normalizeForMatch(currentBody(page.body)).includes(wanted);
  };
  const proofs = [];
  for (const { file, action } of diff.files) {
    const prior = await before(file);
    const next = action === 'removed' ? null : await after(file);
    const revision = next ? memoryHash(next.raw) : 'removed';
    let hasQuote = false;
    for (const item of evidence) {
      if (item.file !== file || item.revision !== revision || item.verified !== true) continue;
      if (await pageStillSays(item)) {
        hasQuote = true;
        break;
      }
    }
    let preserved = false;
    let dependsOn;
    if (next) {
      const moved = await Promise.all(Object.keys(links).filter((source) => endOfMove(source) === file).map(before));
      const priorFacts = facts(prior);
      const nextFacts = facts(next);
      preserved = Boolean(prior || moved.some(Boolean))
        && contains(nextFacts, priorFacts)
        && contains([...priorFacts, ...moved.flatMap(facts)], nextFacts)
        && moved.filter(Boolean).every((entry) => memoryStatusOf(entry.body) === memoryStatusOf(next.body)
          && entry.frontmatter.type === next.frontmatter.type)
        && (!prior || (memoryStatusOf(prior.body) === memoryStatusOf(next.body)
          && prior.frontmatter.type === next.frontmatter.type))
        && (next.frontmatter.description === prior?.frontmatter.description
          || !next.frontmatter.description || moved.some((entry) => entry?.frontmatter.description === next.frontmatter.description));
    } else if (prior && Object.hasOwn(links, file)) {
      const dest = endOfMove(file);
      const entry = dest ? await after(dest) : null;
      preserved = Boolean(entry) && contains(facts(entry), facts(prior))
        && memoryStatusOf(prior.body) === memoryStatusOf(entry.body)
        && prior.frontmatter.type === entry.frontmatter.type;
      if (preserved) dependsOn = dest;
    }
    proofs.push({ file, action, revision, kind: hasQuote ? 'citation' : preserved ? 'preserved' : 'missing',
      ...(dependsOn && !hasQuote ? { dependsOn } : {}) });
  }
  return proofs;
}

/** Without explicit model dependencies, a failed write invalidates destructive follow-ups. */
export function dropDestructiveDependents(original, accepted) {
  const rejectedWrite = (original ?? []).filter(op => op?.op === 'write').length
    > (accepted ?? []).filter(op => op?.op === 'write').length;
  const dropped = [];
  const operations = (accepted ?? []).filter(op => {
    if (!rejectedWrite || (op.op !== 'delete' && op.op !== 'index')) return true;
    dropped.push(`${op.op}${op.file ? ` ${op.file}` : ''}: dropped dependency because a write was rejected; regenerate the plan`);
    return false;
  });
  return { operations, dropped };
}
