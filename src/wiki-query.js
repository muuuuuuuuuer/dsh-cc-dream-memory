/**
 * Read-only query helpers for a knowledge wiki.
 *
 * Query is deliberately tool-only: the model can search, read pages and follow
 * links, but no tool writes the wiki. `wiki_answer` gives the host a structured
 * place to validate citations before accepting an answer.
 */
import { WikiStore, claimsForCitations, extractFactClaims, supersededClaims } from './wiki-store.js';
import { normalizeForMatch } from './dream-evidence.js';
import { extractCitations, extractLinks, fileSlug } from './wiki-core.js';

/** Open the wiki store for one project context. */
export function wikiStoreFor(pctx, config = {}) {
  const root = pctx?.paths?.wikiDir;
  if (typeof root !== 'string' || root === '') return undefined;
  return new WikiStore({ rootDir: root, maxPageBytes: config.wikiMaxPageBytes, config });
}

/**
 * Search the wiki.
 * @returns {Promise<Array<object>>}
 */
export async function searchWiki(store, query, { limit = 5 } = {}) {
  if (!store) return [];
  return store.search(query, { limit });
}

/** Read one page; undefined when absent. */
export async function readWikiPage(store, file) {
  if (!store) return undefined;
  try {
    return await store.readPage(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** One-hop link traversal: outgoing and incoming links for a page. */
export async function wikiLinks(store, file) {
  if (!store) return { page: file, links: [], backlinks: [] };
  const page = await readWikiPage(store, file);
  if (!page) return { page: file, links: [], backlinks: [] };
  const links = extractLinks(page.body);
  const backlinks = await store.backlinks(fileSlug(file));
  return { page: file, links, backlinks };
}

/**
 * Validate a structured answer's citations.
 *
 * A citation names one fact claim:
 *   - `{page, claimId, quote?}`: the page must exist and the claim id must be one
 *     of that page's derived fact claims. A claim id from a different page, or a
 *     missing one, is rejected: a page-level citation cannot support a fact.
 *   - `quote` is checked against that claim's own text (not the whole page), so a
 *     quote from a sibling claim does not verify this one.
 *
 * An unknown claim is reported as `no record of that fact`, the explicit
 * no-record answer, instead of a generic citation error.
 *
 * @returns {Promise<{ok:boolean, errors:string[], citations:object[], noRecord:boolean}>}
 */
export async function validateWikiAnswer(store, { answer = '', citations = [] } = {}) {
  const errors = [];
  let noRecord = false;
  if (String(answer ?? '').trim() === '') errors.push('answer is empty');
  if (!Array.isArray(citations) || citations.length === 0) errors.push('at least one citation is required');
  const checked = [];
  for (const item of Array.isArray(citations) ? citations : []) {
    const pageName = typeof item === 'string' ? item : item?.page;
    const file = typeof pageName === 'string' && pageName.endsWith('.md') ? pageName : `${String(pageName ?? '').replace(/\.md$/i, '')}.md`;
    const page = await readWikiPage(store, file);
    if (!page) {
      errors.push(`citation page does not exist: ${file}`);
      continue;
    }
    const quote = typeof item === 'object' && item && typeof item.quote === 'string' ? item.quote.trim() : '';
    const rawClaimId = typeof item === 'object' && item ? item.claimId : undefined;
    if (rawClaimId !== undefined && rawClaimId !== null && rawClaimId !== '' && typeof rawClaimId !== 'string') {
      errors.push(`citation claimId must be a string in ${file}`);
      continue;
    }
    const wantedClaimId = typeof rawClaimId === 'string' ? rawClaimId.trim() : '';
    if (wantedClaimId === '') {
      errors.push(`citation needs a claimId for one fact line of ${file}; a page-level citation cannot support a fact`);
      continue;
    }
    const claims = Array.isArray(page.claims) ? page.claims : extractFactClaims(page.body, { file: page.file });
    const claim = claims.find((candidate) => candidate.claimId === wantedClaimId);
    if (!claim) {
      noRecord = true;
      errors.push(`no record of that fact on ${file}: ${wantedClaimId}`);
      continue;
    }
    if (quote !== '') {
      const claimText = normalizeForMatch(claim.text);
      const needle = normalizeForMatch(quote);
      if (!claimText.includes(needle) && !needle.includes(claimText)) {
        errors.push(`citation quote does not match claim ${claim.claimId} on ${file}`);
        continue;
      }
    }
    // A conflicting fact stays on the page with a marker naming the newer value.
    // An answer may not cite the replaced line as if it were current.
    const replaced = supersededClaims(page.body, { file: page.file }).find((item) => item.claimId === claim.claimId);
    if (replaced && replaced.newerValues.length > 0) {
      const plain = normalizeForMatch(answer);
      const missing = replaced.newerValues.filter((value) => !plain.includes(normalizeForMatch(value)));
      if (missing.length > 0) {
        errors.push(`claim ${claim.claimId} on ${file} was replaced by a newer source (${replaced.date}); the answer must also state ${replaced.newerValues.join(', ')}`);
        continue;
      }
    }
    checked.push({ page: file, claimId: claim.claimId, claim, ...(quote ? { quote } : {}) });
  }
  return { ok: errors.length === 0, errors, citations: checked, noRecord };
}

/** Build the system text for a read-only query agent. */
export function wikiQueryPrompt({ wikiDir = '', required = true } = {}) {
  return [
    'A read-only knowledge wiki is available through the wiki tools.',
    'Start with wiki_search, then wiki_read or wiki_links. Do not answer from the raw documents.',
    'Every factual statement must cite a page and one of the fact claims returned by wiki_search/wiki_read.',
    'When a page marks a value as replaced by a newer source, state both values and say which one is newer; never present the replaced value alone.',
    'Use wiki_answer with {page, claimId} per fact (quote optional); claimId is the stable id of the supporting fact line.',
    required ? 'If the wiki does not contain the answer, say that the wiki has no record instead of guessing.' : '',
    wikiDir ? `Wiki root: ${wikiDir}` : '',
  ].filter(Boolean).join('\n');
}

/** Extract citations present in a page body, for tool rendering. */
export function pageCitations(page) {
  const body = page?.body ?? '';
  const file = page?.file ?? '';
  const claims = Array.isArray(page?.claims) ? page.claims : extractFactClaims(body, { file });
  return claimsForCitations(extractCitations(body), claims).map((citation) => ({ ...citation, page: file }));
}
