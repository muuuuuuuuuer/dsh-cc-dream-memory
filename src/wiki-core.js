/**
 * Shared wiki primitives for agent memory and knowledge wikis.
 *
 * Both stores use the same page shape:
 *
 *   ---
 *   name: project_testing
 *   description: ...
 *   domain: testing
 *   type: project
 *   modified: 2026-11-10T...
 *   ---
 *
 *   - A fact with provenance. ^[source#locator, 2026-11-08]
 *   - Related topic: [[project_release]]
 *
 * A page references another page with `[[slug]]` and supports a fact with an
 * inline citation token. The module is intentionally pure (no I/O) so the dream
 * pipeline, the knowledge-wiki build and the query tools agree on one syntax.
 */
import { createHash } from 'node:crypto';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

export const WIKI_INDEX_NAME = '_index.md';
export const WIKI_SKILL_NAME = 'SKILL.md';
export const WIKI_PAGE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
export const WIKI_RESERVED = new Set([WIKI_INDEX_NAME, WIKI_SKILL_NAME]);
export const WIKI_GENERATIONS_DIR = '.generations';
export const WIKI_GENERATION_NAME = 'GENERATION';
export const DEFAULT_MAX_PAGE_BYTES = 102_400; // 100 KB, the platform store cap

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;
const CITATION_RE = /\^\[([^\]\n]+)\]/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

/** Collapse whitespace and trim, without truncating. */
export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Byte length of a UTF-8 string. */
export function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

/**
 * Stable page slug: lowercase, letters/digits/CJK, dots, dashes and
 * underscores. Spaces and punctuation collapse to one dash. An empty result
 * falls back to a short content hash so a page never loses its identity.
 */
export function slugify(value) {
  const raw = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (raw !== '') return raw.slice(0, 120);
  return `page-${createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 10)}`;
}

/** File name for a page slug. */
export function pageFile(slug) {
  const value = slugify(slug).replace(/\.md$/i, '');
  return `${value}.md`;
}

/** Slug of a page file name. */
export function fileSlug(file) {
  return String(file ?? '').replace(/\.md$/i, '');
}

/** A short stable id for a claim; used in query citations and manifests. */
export function claimId(input) {
  const stable = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return `c${createHash('sha1').update(stable).digest('hex').slice(0, 12)}`;
}

/** Remove fenced and inline code before scanning for links/citations. */
export function stripCode(body) {
  return String(body ?? '')
    .replace(FENCE_RE, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Extract `[[slug]]` references, ignoring code blocks. A link may carry a
 * display label as `[[slug|label]]`; only the slug is returned.
 * @returns {string[]} unique slugs in first-seen order.
 */
export function extractLinks(body) {
  const seen = new Set();
  const out = [];
  const text = stripCode(body);
  for (const match of text.matchAll(LINK_RE)) {
    const target = String(match[1] ?? '').split('|')[0].trim();
    if (target === '') continue;
    const slug = slugify(target);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/**
 * Rewrite every `[[old]]`/`[[old|label]]` reference through `mapping`.
 * Rewriting stops at one pass so a renamed page cannot cascade.
 */
export function rewriteLinks(body, mapping) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  return String(body ?? '').replace(LINK_RE, (whole, inner) => {
    const [targetPart, labelPart] = String(inner).split('|');
    const target = targetPart.trim();
    if (target === '') return whole;
    const replacement = map[target] ?? map[slugify(target)];
    if (replacement === undefined || replacement === null || replacement === '') return whole;
    const slug = slugify(replacement);
    return labelPart === undefined ? `[[${slug}]]` : `[[${slug}|${labelPart}]]`;
  });
}

/**
 * Parse one inline citation token body. Accepted shapes:
 *   session-abc#412, 2026-11-08
 *   doc-1#p12, 2026-01-15
 *   doc-1 (no locator/date)
 * @returns {{source:string,locator:string,date:string,raw:string}}
 */
export function parseCitation(raw) {
  const value = oneLine(raw);
  const [beforeDate, afterDate] = value.split(/\s*,\s*(?=\d{4}-\d{2}-\d{2})/);
  const dateMatch = (afterDate ?? value).match(DATE_RE);
  const date = dateMatch ? dateMatch[1] : '';
  const sourcePart = date ? beforeDate : value.replace(DATE_RE, '').replace(/,\s*$/, '').trim();
  const hash = sourcePart.indexOf('#');
  const source = (hash >= 0 ? sourcePart.slice(0, hash) : sourcePart).trim();
  const locator = hash >= 0 ? sourcePart.slice(hash + 1).trim() : '';
  return { source, locator, date, raw: value };
}

/** Extract unique citations from a body (ignoring code blocks). */
export function extractCitations(body) {
  const seen = new Set();
  const out = [];
  for (const match of stripCode(body).matchAll(CITATION_RE)) {
    const citation = parseCitation(match[1]);
    if (citation.source === '') continue;
    const key = `${citation.source}#${citation.locator}@${citation.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

/** Render one citation token (without the surrounding `^[...]`). */
export function formatCitation({ source, locator = '', date = '' } = {}) {
  const src = oneLine(source);
  const loc = oneLine(locator);
  const at = oneLine(date);
  return `${src}${loc ? `#${loc}` : ''}${at ? `, ${at}` : ''}`;
}

/** Render a citation with its `^[...]` wrapper. */
export function citationToken(input) {
  return `^[${formatCitation(input)}]`;
}

/**
 * Split a page into frontmatter data and body.
 * @param {string} raw
 */
export function parsePage(raw) {
  const parsed = parseFrontmatter(raw);
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  return {
    data: {
      ...data,
      name: oneLine(data.name) || '',
      description: oneLine(data.description) || '',
      domain: oneLine(data.domain) || '',
      type: oneLine(data.type) || '',
      modified: oneLine(data.modified) || '',
      created: oneLine(data.created) || '',
    },
    body: parsed.body,
    raw: parsed.raw,
    hasFrontmatter: parsed.hasFrontmatter,
  };
}

/** Build one page's full text with canonical field order. */
export function renderPage({ name, description = '', domain = '', type = '', modified = '', created = '', body = '', extra = {} } = {}) {
  const data = {
    name: oneLine(name),
    description: oneLine(description),
    ...(domain ? { domain: oneLine(domain) } : {}),
    ...(type ? { type: oneLine(type) } : {}),
    ...(modified ? { modified: oneLine(modified) } : {}),
    ...(created ? { created: oneLine(created) } : {}),
    ...extra,
  };
  return stringifyFrontmatter(data, String(body ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
}

/** Page metadata used by indexes and search. */
export function pageMeta({ file, data, body, raw }) {
  const text = String(body ?? '');
  return {
    file,
    slug: fileSlug(file),
    name: oneLine(data?.name) || fileSlug(file),
    description: oneLine(data?.description) || '',
    domain: oneLine(data?.domain) || '',
    type: oneLine(data?.type) || '',
    modified: oneLine(data?.modified) || '',
    bytes: byteLength(raw ?? text),
    links: extractLinks(text),
    citations: extractCitations(text),
  };
}

/**
 * Build a complete index. `pages` are `pageMeta()` objects.
 * @param {{pages:object[], style?:'wiki'|'memory', title?:string, groupBy?:string}} options
 * @returns {string}
 */
export function buildIndex({ pages = [], style = 'wiki', title = '', groupBy = 'domain' } = {}) {
  const groups = new Map();
  for (const page of pages) {
    if (!page || typeof page.file !== 'string' || page.file === '') continue;
    const key = oneLine(page[groupBy]) || (style === 'memory' ? oneLine(page.type) : '') || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }
  const lines = [];
  if (oneLine(title) !== '') lines.push(`# ${oneLine(title)}`, '');
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${key}`, '');
    for (const page of groups.get(key).sort((a, b) => a.name.localeCompare(b.name))) {
      const description = page.description === '' ? '' : ` — ${page.description}`;
      if (style === 'memory') {
        lines.push(`- [${page.name}](${page.file})${description}`);
      } else {
        lines.push(`- [[${page.slug}]]${description}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** Build the small usage skill that sits beside an index. */
export function buildSkill({ title = 'Memory', description = '', domains = [], style = 'wiki' } = {}) {
  const domainList = Array.isArray(domains) ? domains.filter(Boolean) : [];
  const lines = [
    '---',
    `name: ${slugify(title)}`,
    `description: ${oneLine(description || `How to use the ${title} store.`)}`,
    '---',
    '',
    `# ${oneLine(title)}`,
    '',
    `Start at ${style === 'memory' ? 'MEMORY.md' : '_index.md'} — it is the catalog.`,
    'Read only the pages a task needs; do not load the whole store.',
    '',
    '## Rules',
    `- Follow [[links]] to related pages.`,
    `- Every durable fact should carry its source: \`^[source#locator, YYYY-MM-DD]\`.`,
    '- A `CONFLICT:` line means two sources disagree; keep both and check before relying on either.',
    '- A fact marked superseded keeps its old value and date; prefer the current value and re-check it.',
    '- Memory and wiki pages can lag behind reality; re-check anything that matters.',
    ...(domainList.length ? ['', `## Domains`, ...domainList.map((domain) => `- ${domain}`)] : []),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Lightweight page validation; write paths still enforce their own limits.
 * @param {{file:string, text:string, maxBytes?:number}} input
 * @returns {{ok:boolean, errors:string[], warnings:string[], links:string[], citations:object[]}}
 */
export function validatePage({ file, text, maxBytes = DEFAULT_MAX_PAGE_BYTES } = {}) {
  const errors = [];
  const warnings = [];
  const name = String(file ?? '');
  if (!WIKI_PAGE_RE.test(name) || WIKI_RESERVED.has(name)) errors.push(`invalid page file: ${name || '(empty)'}`);
  const bytes = byteLength(text);
  if (bytes > maxBytes) errors.push(`page is ${bytes} bytes, limit is ${maxBytes}`);
  const parsed = parsePage(text);
  if (!parsed.hasFrontmatter) warnings.push('page has no frontmatter');
  if (parsed.data.name === '') errors.push('page frontmatter needs a name');
  if (parsed.data.description === '') warnings.push('page frontmatter has no description');
  const links = extractLinks(parsed.body);
  const citations = extractCitations(parsed.body);
  return { ok: errors.length === 0, errors, warnings, links, citations };
}

/** Split a body into Markdown sections by `## ` headings (the first chunk is the preamble). */
export function splitSections(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  const sections = [];
  let current = { heading: '', text: [] };
  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (current.heading !== '' || current.text.join('').trim() !== '') sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), text: [line] };
    } else {
      current.text.push(line);
    }
  }
  if (current.heading !== '' || current.text.join('').trim() !== '') sections.push(current);
  return sections.map((section) => ({ heading: section.heading, text: section.text.join('\n') }));
}

/** Keep only unique non-empty lines, preserving order. */
export function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const value = String(line ?? '').trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
