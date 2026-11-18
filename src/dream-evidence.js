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
import { contradictsClaim, supportConflict, supportsStatement, supportTokens } from './support.js';
import { memoryHash } from './write-review.js';

/** Below this many significant characters a quote proves nothing. */
const TRANSCRIPT_TAG = /^\[(user|user-pasted|assistant|tool-call|tool-result|tool-error)\] ?/;
const DATE_MARKER = /^--- (\d{4}-\d{2}-\d{2}) ---$/;
const RETIREMENT = /\b(?:remove|delete|retir(?:e|ed)|obsolete|deprecated|replac(?:e|ed)|superseded)\b|删除|移除|废弃|停用|淘汰|已替换/iu;
const UNCERTAIN_RETIREMENT = /[?？]|\b(?:not|never|don't|if|unless|should|could|may|might)\b|不要|不可|尚未|未被|如果|是否/iu;
const MODALITY = /\b(?:must|should|may|can|will|always|never|required|optional)\b/giu;
const REPLACEMENT = /^(?:please\s+)?replace (.+?) with (.+)$/iu;

const normalizePassage = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();
const splitPassages = (text) => text.split(/\r?\n|(?<=[.!?])\s+|(?<=[。！？；])\s*|;\s+/u)
  .map((part) => part.trim()).filter(Boolean);

/** Check the enclosing passage so a clipped quote cannot omit negation or conditions. */
export function sourcePassages(text, quote) {
  const wanted = normalizePassage(quote).replace(/…+$/u, '');
  return wanted ? splitPassages(text).filter((part) => normalizePassage(part).includes(wanted)) : [];
}

function supportsClaim(claim, passage) {
  if (normalizePassage(claim) === normalizePassage(passage)) return true;
  const replacement = REPLACEMENT.exec(passage);
  const source = replacement && !UNCERTAIN_RETIREMENT.test(passage) ? replacement[2] : passage;
  if (source === passage && RETIREMENT.test(passage) && !RETIREMENT.test(claim)) return false;
  if (!supportsStatement(claim, source, { minRatio: 1 })) return false;
  if (String(claim.match(MODALITY) ?? '').toLowerCase() !== String(source.match(MODALITY) ?? '').toLowerCase()) return false;
  const words = (value) => (value.match(/[a-z0-9][a-z0-9_+#.-]*|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/giu) ?? [])
    .flatMap((word) => [...supportTokens(word)]);
  const tokens = words(source);
  let offset = -1;
  return words(claim).every((token) => {
    offset = tokens.indexOf(token, offset + 1);
    return offset !== -1;
  });
}

function supportsRemoval(claim, passage, file) {
  if (!RETIREMENT.test(passage)) {
    return ['negation', 'quantity'].includes(supportConflict(claim, passage)) && contradictsClaim(claim, passage);
  }
  if (UNCERTAIN_RETIREMENT.test(passage)) return false;
  const words = supportTokens(REPLACEMENT.exec(passage)?.[1] ?? passage);
  if (words.has(file.toLowerCase())) return true;
  const tokens = [...supportTokens(claim)];
  const matches = tokens.filter((token) => words.has(token));
  return (matches.length >= 2 && matches.length === tokens.length)
    || matches.some((token) => /\d|[-_.]/u.test(token));
}

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
  const claims = (lines) => lines.flatMap((line) => {
    const at = line.lastIndexOf(' » ');
    const context = at === -1 ? '' : line.slice(0, at + 3);
    const text = line.slice(context.length).replace(/\^\[[^\]]*\]/gu, '');
    return splitPassages(text).map((part) => context + part);
  });
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
  const passagesOf = async (item) => {
    if (item.source !== 'memory') return item.passages ?? [];
    const [original, page] = await Promise.all([before(item.memoryFile), after(item.memoryFile)]);
    if (!original || !page || page.file === item.file) return [];
    const originalPassages = sourcePassages(currentBody(original.body), item.quote);
    const shadowPassages = sourcePassages(currentBody(page.body), item.quote);
    const originals = new Set(originalPassages.map(normalizePassage));
    return shadowPassages.length > 0 && shadowPassages.every((part) => originals.has(normalizePassage(part)))
      ? [...originalPassages, ...shadowPassages] : [];
  };
  const proofs = [];
  for (const { file, action } of diff.files) {
    const prior = await before(file);
    const next = action === 'removed' ? null : await after(file);
    const revision = next ? memoryHash(next.raw) : 'removed';
    const checked = [];
    for (const [index, item] of evidence.entries()) {
      if (item.file !== file || item.revision !== revision || item.verified !== true) continue;
      const passages = await passagesOf(item);
      if (passages.length > 0) checked.push({ index, passages: [item.quote, ...passages], claims: [] });
    }
    let preserved = false;
    let descriptionOnly = false;
    let dependsOn;
    let added = [];
    let removed = claims(facts(prior));
    if (next) {
      const moved = await Promise.all(Object.keys(links).filter((source) => endOfMove(source) === file).map(before));
      const priorFacts = facts(prior);
      const nextFacts = facts(next);
      const oldClaims = new Set(claims([...priorFacts, ...moved.flatMap(facts)]));
      const newClaims = new Set(claims(nextFacts));
      added = [...newClaims].filter((claim) => !oldClaims.has(claim));
      removed = removed.filter((claim) => !newClaims.has(claim));
      const sameFacts = Boolean(prior || moved.some(Boolean))
        && contains(nextFacts, priorFacts)
        && contains([...priorFacts, ...moved.flatMap(facts)], nextFacts)
        && moved.filter(Boolean).every((entry) => memoryStatusOf(entry.body) === memoryStatusOf(next.body)
          && entry.frontmatter.type === next.frontmatter.type)
        && (!prior || (memoryStatusOf(prior.body) === memoryStatusOf(next.body)
          && prior.frontmatter.type === next.frontmatter.type));
      // A description states which questions the page answers, and recall shows
      // nothing but its first characters. Rewriting it while the facts stay put
      // loses nothing, so it gets its own kind instead of demanding a citation
      // no page can supply for a rewording.
      const sameDescription = next.frontmatter.description === prior?.frontmatter.description
        || !next.frontmatter.description || moved.some((entry) => entry?.frontmatter.description === next.frontmatter.description);
      preserved = sameFacts && sameDescription;
      descriptionOnly = sameFacts && !sameDescription;
    } else if (prior && Object.hasOwn(links, file)) {
      const dest = endOfMove(file);
      const entry = dest ? await after(dest) : null;
      preserved = Boolean(entry) && contains(facts(entry), facts(prior))
        && memoryStatusOf(prior.body) === memoryStatusOf(entry.body)
        && prior.frontmatter.type === entry.frontmatter.type;
      if (preserved) dependsOn = dest;
    }
    const changes = [...new Set([...added, ...removed])];
    for (const item of checked) {
      item.claims = [
        ...added.filter((claim) => item.passages.every((passage) => supportsClaim(claim, passage))),
        ...removed.filter((claim) => item.passages.every((passage) => supportsRemoval(claim, passage, next ? '' : file))),
      ];
    }
    const covered = new Set(checked.flatMap((item) => item.claims));
    const unsupportedClaims = preserved || descriptionOnly ? [] : changes.filter((claim) => !covered.has(claim));
    const hasSupport = unsupportedClaims.length === 0 && changes.length > 0;
    proofs.push({ file, action, revision, unsupportedClaims,
      kind: preserved ? 'preserved' : descriptionOnly ? 'description' : hasSupport ? 'citation' : 'missing',
      bindings: checked.map(({ index, claims }) => ({ index, claims })),
      ...(dependsOn ? { dependsOn } : {}) });
  }
  return proofs;
}
