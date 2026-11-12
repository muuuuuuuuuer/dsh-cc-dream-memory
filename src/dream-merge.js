/**
 * Host merge for claim-level Dream runs.
 *
 * The analyzer already returns one claim per fact: the statement, a verbatim
 * quote, the source page and the verdicts that cover the page's existing lines.
 * This module turns those verified claims into page bodies without asking a
 * model to rewrite a whole page, which is what the terminal organizer did:
 *
 * - a new fact becomes one cited line on its target page;
 * - a verified `contradicts` verdict replaces the one line it names and moves the
 *   old value into history;
 * - a claim that cannot be placed unambiguously (several matching lines, a
 *   low-confidence source, no citable position) becomes a review item instead of
 *   a write;
 * - a page no claim mentions is not written at all, so a session that never
 *   discusses a note leaves that note untouched;
 * - identical facts from several sessions merge into one line with both
 *   citations, which is how a discovery split across sessions becomes usable.
 *
 * The output is ordinary write/index operations, so the existing evidence gate,
 * secret scan, backup and undo still run unchanged.
 */
import { createHash } from 'node:crypto';
import { bodyLineChanges } from './dream-evidence.js';
import { citationToken, extractCitations } from './wiki-core.js';
import { normalizeForMatch } from './dream-evidence.js';

const PAGE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
const RESERVED = new Set(['MEMORY.md', 'SKILL.md', '_index.md', '.dream-log.md']);
const HISTORY_RE = /^##\s+History\s*$/iu;
const STATUS_RE = /^\s*STATUS:\s*([a-z-]+)\s*$/iu;
const BULLET_RE = /^\s*[-*]\s+/u;
const USER_CLASS = new Set(['user', 'feedback']);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'also',
  'use', 'uses', 'used', 'using', 'run', 'runs', 'ran', 'must', 'should', 'will', 'would',
  'page', 'note', 'notes', 'memory', 'session', 'user', 'agent', 'project', 'current', 'value',
]);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value, max = 400) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function normalizeLight(value) {
  return text(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function hashOf(value) {
  return createHash('sha256').update(text(value), 'utf8').digest('hex');
}

function safePage(file) {
  const name = oneLine(file, 200);
  if (!PAGE_RE.test(name) || RESERVED.has(name) || name.includes('..')) return '';
  return name;
}

function slug(value, max = 40) {
  return text(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, max)
    .replace(/-+$/u, '');
}

function words(value) {
  return new Set(
    text(value)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/gu)
      .filter(word => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

function overlap(a, b) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

function bodyLines(body) {
  return text(body).replace(/\r\n?/g, '\n').split('\n');
}

function statusOf(lines) {
  for (const line of lines) {
    const match = STATUS_RE.exec(line);
    if (match !== null) return match[1].toLowerCase();
  }
  return '';
}

function withStatusCurrent(lines) {
  const index = lines.findIndex(line => STATUS_RE.test(line));
  if (index >= 0) {
    lines[index] = 'STATUS: current';
    return lines;
  }
  const firstContent = lines.findIndex(line => line.trim() !== '');
  lines.splice(firstContent >= 0 ? firstContent : 0, 0, 'STATUS: current');
  return lines;
}

function historyIndex(lines) {
  return lines.findIndex(line => HISTORY_RE.test(line));
}

function appendToBody(lines, line) {
  const history = historyIndex(lines);
  if (history >= 0) {
    const insertAt = history > 0 && lines[history - 1].trim() === '' ? history - 1 : history;
    lines.splice(insertAt, 0, line, '');
    return lines;
  }
  const tail = lines.join('\n').replace(/\s+$/u, '');
  const next = tail === '' ? [line] : [...tail.split('\n'), '', line];
  return next;
}

function appendToHistory(lines, entries) {
  if (entries.length === 0) return lines;
  const history = historyIndex(lines);
  if (history >= 0) {
    const rest = lines.slice(history + 1);
    while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop();
    return [...lines.slice(0, history + 1), ...entries, ...rest, ''];
  }
  const tail = lines.join('\n').replace(/\s+$/u, '');
  const head = tail === '' ? [] : tail.split('\n');
  return [...head, '', '## History', ...entries, ''];
}

function typeFromClaim(claim) {
  const kind = text(claim?.kind);
  if (USER_CLASS.has(kind)) return kind;
  if (kind === 'preference') return 'feedback';
  if (kind === 'reference') return 'reference';
  return 'project';
}

function descriptionFromClaim(claim) {
  const explicit = oneLine(claim?.description, 160);
  if (explicit !== '') return explicit;
  return oneLine(claim?.text, 90);
}

function pageKey(pages) {
  const byName = new Map();
  for (const page of pages.values()) {
    byName.set(normalizeLight(page.name), page.file);
    byName.set(normalizeLight(page.file), page.file);
  }
  return byName;
}

/**
 * Pick the page a claim belongs to: the page the analyzer named, then an
 * existing page the claim shares enough words with, then a new file named after
 * the claim. Returns `{file, page}` where `page` is undefined for a new file.
 */
function resolveTarget({ claim, pages, byName, taken }) {
  const named = safePage(claim?.target);
  if (named !== '') {
    const direct = pages.get(named) || pages.get(byName.get(normalizeLight(named)));
    return { file: direct?.file ?? named, page: direct };
  }
  const claimWords = words(`${text(claim?.text)} ${text(claim?.quote)}`);
  let best = null;
  let bestScore = 0;
  for (const page of pages.values()) {
    const score = overlap(claimWords, words(`${page.name} ${page.description} ${page.body}`));
    if (score > bestScore) {
      best = page;
      bestScore = score;
    }
  }
  if (best !== null && bestScore >= 2) return { file: best.file, page: best };
  const base = slug(oneLine(claim?.text, 60)) || slug(text(claim?.kind)) || 'note';
  let candidate = `${base}.md`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}.md`;
    suffix += 1;
  }
  taken.add(candidate);
  return { file: candidate, page: undefined };
}

function citationOf(claim, sessionId) {
  const source = sessionId || text(claim?.sessionId);
  const locator = Number.isFinite(Number(claim?.seq)) ? String(Number(claim.seq)) : '';
  const date = oneLine(claim?.date, 20);
  if (source === '' || locator === '' || date === '') return '';
  return citationToken({ source, locator, date });
}

function claimLine(claim, citations) {
  return `- ${oneLine(claim.text, 1000)} ${citations.join(' ')}`;
}

function supersededLine({ oldValue, date, citation, claim }) {
  const source = text(claim?.quote) === '' ? '' : ` — ${oneLine(claim.quote, 160)}`;
  return `- Superseded: ${oneLine(oldValue, 500)} (until ${date || 'unknown date'})${source} ${citation}`.trim();
}

/**
 * Merge verified claims into write operations.
 * @param {{analyses:Array<{sessionId:string,claims?:object[],verify?:object[]}>,
 *   memoryPages?:Array<{file:string,name?:string,description?:string,type?:string,body?:string}>,
 *   indexText?:string, title?:string, allowLowConfidence?:boolean}} input
 * @returns {{operations:object[], review:object[], warnings:string[], pages:Array<object>, touched:string[]}}
 */
export function mergeClaims({
  analyses = [],
  memoryPages = [],
  indexText = '',
  title = '',
  allowLowConfidence = false,
} = {}) {
  const pages = new Map();
  for (const page of Array.isArray(memoryPages) ? memoryPages : []) {
    if (!page || typeof page.file !== 'string' || page.file === '') continue;
    pages.set(page.file, {
      file: page.file,
      name: oneLine(page.name, 200) || page.file.replace(/\.md$/u, ''),
      description: oneLine(page.description, 400),
      type: oneLine(page.type, 40) || 'project',
      body: text(page.body),
    });
  }
  const byName = pageKey(pages);
  const taken = new Set(pages.keys());
  const warnings = [];
  const review = [];
  const touched = new Set();
  const grouped = new Map(); // file -> Map(normalized text -> {claim, citations, description})

  const verdicts = [];
  for (const analysis of Array.isArray(analyses) ? analyses : []) {
    for (const item of Array.isArray(analysis?.verify) ? analysis.verify : []) {
      if (!item || item.result !== 'contradicts') continue;
      verdicts.push({ ...item, sessionId: text(analysis?.sessionId) });
    }
  }

  for (const analysis of Array.isArray(analyses) ? analyses : []) {
    const sessionId = text(analysis?.sessionId);
    for (const claim of Array.isArray(analysis?.claims) ? analysis.claims : []) {
      if (!claim || text(claim.text).trim() === '') continue;
      if (claim.confidence === 'low' && !allowLowConfidence) {
        review.push({ file: text(claim.target), claim: oneLine(claim.text, 200), reason: 'low-confidence source; nothing to verify it against yet' });
        continue;
      }
      const citation = citationOf(claim, sessionId);
      if (citation === '') {
        warnings.push(`claim without a citable position was skipped: ${oneLine(claim.text, 120)}`);
        continue;
      }
      const target = resolveTarget({ claim, pages, byName, taken });
      const key = normalizeForMatch(claim.text);
      if (key.length < 4) continue;
      if (!grouped.has(target.file)) grouped.set(target.file, new Map());
      const bucket = grouped.get(target.file);
      if (!bucket.has(key)) {
        bucket.set(key, {
          claim: { ...claim, sessionId },
          citations: [citation],
          description: oneLine(claim.description, 160),
          created: target.page === undefined,
        });
      } else {
        const existing = bucket.get(key);
        if (!existing.citations.includes(citation)) existing.citations.push(citation);
        if (existing.description === '' && oneLine(claim.description, 160) !== '') {
          existing.description = oneLine(claim.description, 160);
        }
      }
    }
  }

  const operations = [];
  for (const [file, bucket] of grouped) {
    const page = pages.get(file);
    const lines = page ? bodyLines(page.body) : [];
    let changed = false;
    let corrected = false;
    let descriptionChanged = false;
    let nextDescription = page?.description ?? '';
    let nextType = page?.type ?? 'project';
    let nextName = page?.name ?? file.replace(/\.md$/u, '');
    const historyEntries = [];

    for (const entry of bucket.values()) {
      const { claim, citations } = entry;
      const line = claimLine(claim, citations);
      const existingText = normalizeForMatch(lines.join('\n'));
      // A one-line summary for the first-turn index is a proposal in its own
      // right: a fact that is already recorded can still get a better line.
      if (entry.description !== '' && entry.description !== nextDescription) {
        nextDescription = entry.description;
        descriptionChanged = true;
      } else if (nextDescription === '') {
        nextDescription = descriptionFromClaim(claim);
      }
      if (existingText.includes(normalizeForMatch(claim.text))) continue;
      if (entry.created) {
        nextType = typeFromClaim(claim);
        nextName = oneLine(claim.description, 90) || nextName;
      }

      const matching = verdicts.filter((verdict) =>
        verdict.file === file
        && normalizeLight(verdict.claim) !== ''
        && normalizeLight(lines.join('\n')).includes(normalizeLight(verdict.claim)));
      const targets = [];
      lines.forEach((candidate, index) => {
        const normalized = normalizeLight(candidate);
        if (normalized === '') return;
        if (matching.some((verdict) => normalized.includes(normalizeLight(verdict.claim)))) {
          targets.push(index);
        }
      });
      if (matching.length === 0) {
        lines.splice(0, lines.length, ...appendToBody(lines, line));
        changed = true;
        continue;
      }
      if (targets.length !== 1 || !BULLET_RE.test(lines[targets[0]])) {
        review.push({
          file,
          claim: oneLine(claim.text, 200),
          reason: targets.length === 0
            ? 'the contradicted line is no longer in the page'
            : 'the contradicted value matches more than one line',
        });
        continue;
      }
      const oldLine = lines[targets[0]];
      const oldValue = oldLine.replace(BULLET_RE, '').replace(/\s*\^\[[^\]]*\]\s*$/u, '').trim();
      lines[targets[0]] = line;
      historyEntries.push(supersededLine({ oldValue, date: oneLine(claim.date, 20), citation: citations[0], claim }));
      corrected = true;
      changed = true;
    }

    if (!changed && !(descriptionChanged && page !== undefined)) continue;
    let nextLines = lines;
    if (corrected) nextLines = withStatusCurrent(nextLines);
    if (historyEntries.length > 0) nextLines = appendToHistory(nextLines, historyEntries);
    const body = `${nextLines.join('\n').replace(/\s+$/u, '')}\n`;
    const sameBody = page !== undefined && body === `${text(page.body).replace(/\s+$/u, '')}\n`;
    if (sameBody && !(descriptionChanged && nextDescription !== oneLine(page.description, 400))) continue;
    operations.push({
      op: 'write',
      scope: 'project',
      type: nextType,
      file,
      name: nextName,
      description: nextDescription,
      body,
      ...(page !== undefined ? { baseHash: hashOf(page.body) } : {}),
    });
    touched.add(file);
  }

  if (operations.length > 0) {
    const merged = new Map(pages);
    for (const op of operations) {
      merged.set(op.file, {
        file: op.file,
        name: op.name,
        description: op.description,
        type: op.type,
        body: op.body,
      });
    }
    addRelatedLinks(merged, operations);
    const index = indexText === ''
      ? buildMemoryIndex([...merged.values()], title)
      : indexText;
    if (index.trim() !== '') operations.push({ op: 'index', content: index });
  }

  return { operations, review, warnings, pages: [...pages.values()], touched: [...touched] };
}

/** Host-built index; the organizer used to do this. */
export function buildMemoryIndex(pages, title = '') {
  const groups = new Map();
  for (const page of pages) {
    if (!page || typeof page.file !== 'string') continue;
    const key = oneLine(page.type) || 'project';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  const lines = [];
  if (oneLine(title) !== '') lines.push(`# ${oneLine(title)}`, '');
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${key}`, '');
    for (const item of groups.get(key).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const description = oneLine(item.description) === '' ? '' : ` — ${oneLine(item.description)}`;
      lines.push(`- [${oneLine(item.name)}](${item.file})${description}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

/** Add one `Related:` line when two pages share enough vocabulary. */
function addRelatedLinks(pages, operations) {
  const byFile = new Map();
  for (const op of operations) byFile.set(op.file, op);
  const wordSets = new Map([...pages].map(([file, page]) => [file, words(`${page.name} ${page.description} ${page.body}`)]));
  for (const [file, set] of wordSets) {
    const op = byFile.get(file);
    if (op === undefined) continue;
    const links = [];
    for (const [other, otherSet] of wordSets) {
      if (other === file || overlap(set, otherSet) < 2) continue;
      if (op.body.includes(`[[${other.replace(/\.md$/u, '')}]]`)) continue;
      links.push(`[[${other.replace(/\.md$/u, '')}]]`);
      if (links.length >= 5) break;
    }
    if (links.length === 0) continue;
    op.body = `${op.body.trimEnd()}\n\nRelated: ${links.join(' ')}\n`;
  }
}

/** True when a merged page body only changed by adding cited lines. */
export function mergeSummary(operations) {
  const added = [];
  for (const op of operations) {
    if (op?.op !== 'write') continue;
    for (const line of text(op.body).split('\n')) {
      if (extractCitations(line).length > 0) added.push(fixLine(line, op.file));
    }
  }
  return added.slice(0, 20);
}

function fixLine(line, file) {
  return `${file}: ${oneLine(line, 160)}`;
}

export { bodyLineChanges };
