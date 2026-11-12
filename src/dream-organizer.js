/**
 * One organizer call for a dream batch.
 *
 * The organizer runs once after every analyzer (or once per domain batch when
 * the store is large). It receives the analyzer results and the current memory
 * pages, then returns page writes, deletions, links, conflicts and optional
 * index/SKILL text. It never receives raw transcripts.
 */
import { buildSkill, buildIndex, pageMeta } from './wiki-core.js';

export const ORGANIZER_SYSTEM_PROMPT = `You are the organizer for one dreaming batch. Every analyzer has finished;
you run alone and no other writer is active.

You receive:
1. Analyzer summaries, claims, patches and verification results.
2. The current memory index and page bodies.
3. Optional focus text from the human.

Your job is to leave the memory directory in the shape a future session can
navigate quickly. You do not re-read transcripts and you do not invent facts.

What the host accepts. Every line you add to or change on a page must be one of:
  (a) an existing line copied byte-for-byte from a current page of the same type;
  (b) a line carrying ^[source#seq, date] from an analyzer CLAIM, containing that
      claim's text or quote;
  (c) STATUS / VERIFIED / USER CONFIRMED metadata, headings and blank lines.
If any line on a page fails this, the host refuses the whole change to that
page. Leaving a page unchanged is always better than adding an uncited line.

Rules:
- Merge duplicate or near-duplicate pages into the better-named page. Preserve
  every fact line and every dated history line. When moving an existing line,
  copy it byte-for-byte: no label in front of it (not "回复风格：…"), no
  rewording, no translation, no summary.
- Never merge pages of different types: a feedback line cannot move into a user
  page and keep its standing. Leave such pages separate and link them.
- Distinct topics stay separate. Relations between pages go only in "links";
  the host writes one "Related:" line per page from them. Do not write link
  lines, "Related"/"相关" lines or sections, or notes next to [[links]] in a
  body: the host drops them.
- A clear later correction replaces the old value, but keep the old value as
  history with its date and source. If two statements cannot both be true and
  neither is clearly later, keep both and write a CONFLICT: block with both
  sources and dates.
- Every new or changed fact keeps its inline citation ^[source#locator, date].
- For engineering lessons and feedback, record why it matters in the body:
    APPLIES WHEN: <condition or task shape> ^[source#seq, date]
    VERIFY: <how a future session can check it> ^[source#seq, date]
    OBSERVED: <what happened> ^[source#seq, date]
    EXCEPTION: <the legitimate exception, if any> ^[source#seq, date]
    STATUS: current|stale|superseded|disputed
  STATUS is pure metadata and needs no citation. The other four labels carry
  substantive content and still need a citation; do not hide an uncited fact
  behind a label.
- If a fact is superseded or unverified, mark STATUS accordingly instead of
  silently keeping it current.
- A page whose facts were checked against this batch's transcript gets
  STATUS: current plus VERIFIED: <YYYY-MM-DD>. A page whose rule the user
  explicitly confirmed gets USER CONFIRMED: <YYYY-MM-DD> instead. These date
  lines are metadata; the facts still need citations. Unmarked pages are not
  eligible for the first-turn hot set.
- A page body is the complete new body. Do not return patches relative to text
  you cannot see.
- Keep every page under the byte limit shown by the host. Split a large topic
  into linked pages rather than dropping facts.
- Keep MEMORY.md small: one line per page, grouped by topic. Drop entries only
  when their page is deleted or absorbed.
- Do not write outside the memory directory, never target MEMORY.md/SKILL.md as
  a page, and never carry a secret into any page.

Output ONLY one JSON object:

{
  "summary": "one sentence",
  "writes": [
    {
      "file": "existing_page.md or new_page.md",
      "name": "Page name",
      "description": "one line, at most 160 chars",
      "type": "user|feedback|project|reference",
      "body": "complete Markdown body",
      "reason": "merge|enrich|correct|split|new"
    }
  ],
  "deletes": [
    { "file": "old_page.md", "reason": "absorbed by other_page.md" }
  ],
  "links": [
    { "from": "page.md", "to": "other_page.md" }
  ],
  "conflicts": [
    { "file": "page.md", "content": "CONFLICT: ..." }
  ],
  "index": "optional complete MEMORY.md body; omit to let the host rebuild it",
  "skill": "optional complete SKILL.md body; omit to let the host rebuild it"
}`;

const PAGE_RE = /^[\p{L}\p{N}._-]+\.md$/u;
const RESERVED = new Set(['MEMORY.md', 'SKILL.md', '_index.md', '.dream-log.md']);

// Model-written cross-link lines ("相关：[[a]]（说明）、[[b]]", "See also: [[a]]",
// "- [[a]] (notes)") carry no citation, so the write gate refuses them. The
// host lifts their targets into `links` and renders one structural line itself.
const LINK_LABELS = '(?:相关(?:页面|笔记|链接|主题|内容)?|参见|另见|延伸阅读|关联(?:页面|笔记)?|related(?:\\s+(?:pages?|notes?|topics?))?|see\\s+also|links?)';
const LINK_LINE_LABEL_RE = new RegExp(`^(?:[-+*]\\s+)?(?:[*_]{1,2})?${LINK_LABELS}(?:[*_]{1,2})?\\s*[:：]\\s*`, 'iu');
const LINK_HEADING_RE = new RegExp(`^#{1,6}\\s+${LINK_LABELS}\\s*[:：]?\\s*$`, 'iu');
const WIKI_LINK_RE = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/gu;

/**
 * Targets of a link-only line, or null when the line says anything besides
 * links: an optional label, `[[links]]`, parenthetical notes and separators.
 * Parenthetical notes are dropped with the line, never kept as text.
 * @returns {string[]|null}
 */
export function linkLineTargets(line) {
  const value = String(line ?? '').trim();
  const labelled = LINK_LINE_LABEL_RE.exec(value);
  const rest = labelled ? value.slice(labelled[0].length) : value.replace(/^[-+*]\s+/u, '');
  if (!labelled && !rest.startsWith('[[')) return null;
  const targets = [...rest.matchAll(WIKI_LINK_RE)].map((match) => match[1].trim()).filter(Boolean);
  if (targets.length === 0) return null;
  const leftover = rest
    .replace(WIKI_LINK_RE, '')
    .replace(/（[^（）]*）|\([^()]*\)/gu, '')
    .replace(/\b(?:and|or)\b/giu, '')
    .replace(/[\s、，,;；。.·/|和与及或]/gu, '');
  return leftover === '' ? targets : null;
}

/**
 * Remove model-written link-only lines (and a "Related"/"相关" heading left
 * empty) from a page body. Fenced code is left alone.
 * @returns {{body:string, targets:string[]}}
 */
export function extractLinkLines(body) {
  const lines = text(body).split('\n');
  const kept = [];
  const targets = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fence = !fence;
      kept.push(line);
      continue;
    }
    const found = fence ? null : linkLineTargets(line);
    if (found) {
      targets.push(...found);
      continue;
    }
    kept.push(line);
  }
  const out = [];
  for (let index = 0; index < kept.length; index += 1) {
    if (LINK_HEADING_RE.test(kept[index].trim())) {
      let next = index + 1;
      while (next < kept.length && kept[next].trim() === '') next += 1;
      if (next >= kept.length || /^#{1,6}\s/u.test(kept[next].trim())) {
        index = next - 1;
        continue;
      }
    }
    out.push(kept[index]);
  }
  return {
    body: out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, ''),
    targets: [...new Set(targets)],
  };
}

/**
 * Write cross-links into page bodies: one structural `Related: [[a]] [[b]]`
 * line per page, only to pages that exist after deletions, skipping targets the
 * body already links. Mutates `pages` (Map file -> page).
 */
export function renderRelatedLinks(pages, links) {
  const targets = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || link.from === link.to || !pages.has(link.from) || !pages.has(link.to)) continue;
    const slug = link.to.replace(/\.md$/u, '');
    const body = text(pages.get(link.from).body);
    if (body.includes(`[[${slug}]]`) || body.includes(`[[${slug}|`)) continue;
    if (!targets.has(link.from)) targets.set(link.from, []);
    if (!targets.get(link.from).includes(slug)) targets.get(link.from).push(slug);
  }
  for (const [file, slugs] of targets) {
    const page = pages.get(file);
    page.body = `${text(page.body).trimEnd()}\n\nRelated: ${slugs.map((slug) => `[[${slug}]]`).join(' ')}\n`;
  }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value, max = 400) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function safeFile(value) {
  const name = oneLine(value, 200);
  if (!PAGE_RE.test(name) || RESERVED.has(name) || name.includes('..')) return '';
  return name;
}

function clip(value, max) {
  const body = text(value).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return body.length > max ? body.slice(0, max) : body;
}

/** Build the organizer prompt. */
export function buildOrganizerPrompt({
  analyses = [],
  memoryPages = [],
  index = '',
  focus = '',
  limits = {},
} = {}) {
  const maxPageChars = Number(limits.maxPageChars) || 20_000;
  const maxCurrentChars = Number(limits.maxCurrentChars) || 60_000;
  const maxAnalysisChars = Number(limits.maxAnalysisChars) || 60_000;
  const parts = [
    '# Dream organizer',
    focus ? `Human focus for this pass: ${focus}` : '',
    '',
    '## Deployment limits',
    `- one page body: at most ${maxPageChars} characters`,
    `- page limit: ${Number(limits.maxPages) || 200}`,
    '',
    '## Current MEMORY.md',
    index.trim() || '(empty index)',
    '',
    '## Current pages',
  ];
  let used = 0;
  for (const page of memoryPages) {
    const file = text(page?.file);
    if (file === '') continue;
    const block = `### ${file}\n(${text(page?.type) || 'memory'})\n${text(page?.body) || '(empty)'}`;
    if (used + block.length > maxCurrentChars) {
      parts.push('(remaining pages omitted for budget)');
      break;
    }
    used += block.length;
    parts.push(block);
  }
  if (memoryPages.length === 0) parts.push('(no pages yet)');
  parts.push('', '## Analyzer results');
  used = 0;
  for (const analysis of analyses) {
    const lines = [
      `### session ${text(analysis?.sessionId) || '(unknown)'}`,
      oneLine(analysis?.summary, 1000) || '(no summary)',
      ...(Array.isArray(analysis?.claims) ? analysis.claims.map((claim) => {
        const source = text(claim.sessionId) || text(claim.source) || '?';
        const locator = Number.isFinite(Number(claim.seq)) ? `#${Number(claim.seq)}` : '';
        const date = text(claim.date);
        return `- CLAIM [${text(claim.kind)}/${text(claim.confidence)}] ${oneLine(claim.text, 400)} (cite: ^[${source}${locator}${date ? `, ${date}` : ''}])`;
      }) : []),
      ...(Array.isArray(analysis?.patches) ? analysis.patches.map((patch) => `- PATCH ${text(patch.file)} (${text(patch.op)}): ${oneLine(patch.content, 600)}`) : []),
      ...(Array.isArray(analysis?.verify) ? analysis.verify.map((item) => `- VERIFY ${text(item.file)}: ${text(item.result)} — ${oneLine(item.claim, 300)}`) : []),
    ];
    const block = lines.join('\n');
    if (used + block.length > maxAnalysisChars) {
      parts.push('(remaining analyzer results omitted for budget)');
      break;
    }
    used += block.length;
    parts.push(block);
  }
  if (analyses.length === 0) parts.push('(no analyzer results)');
  parts.push('', 'Return only the JSON object described in your system prompt.');
  return parts.filter((line) => line !== '').join('\n\n');
}

/** Extract the first JSON object from a model reply. */
export function extractJsonObject(input) {
  const value = text(input).trim();
  if (value === '') return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : value;
  const candidates = [source];
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try next
    }
  }
  return null;
}

/** Normalize one organizer reply. */
export function normalizeOrganizerReply(parsed, { maxWrites = 40, maxPageChars = 20_000, maxDeletes = 40, maxLinks = 80, maxConflicts = 40 } = {}) {
  const raw = parsed && typeof parsed === 'object' ? parsed : {};
  const writes = [];
  const bodyLinks = [];
  for (const write of Array.isArray(raw.writes) ? raw.writes : []) {
    if (writes.length >= maxWrites) break;
    const file = safeFile(write?.file);
    if (file === '') continue;
    const extracted = extractLinkLines(clip(write?.body, maxPageChars));
    for (const target of extracted.targets) {
      const to = safeFile(target.endsWith('.md') ? target : `${target}.md`);
      if (to !== '' && to !== file) bodyLinks.push({ from: file, to });
    }
    const body = extracted.body;
    if (body.trim() === '') continue;
    const type = ['user', 'feedback', 'project', 'reference'].includes(write?.type) ? write.type : 'project';
    writes.push({
      file,
      name: oneLine(write?.name, 200) || file.replace(/\.md$/, ''),
      description: oneLine(write?.description, 160),
      domain: oneLine(write?.domain, 80),
      type,
      body,
      reason: oneLine(write?.reason, 40) || 'update',
    });
  }
  const deletes = [];
  for (const item of Array.isArray(raw.deletes) ? raw.deletes : []) {
    if (deletes.length >= maxDeletes) break;
    const file = safeFile(item?.file);
    if (file === '') continue;
    deletes.push({ file, reason: oneLine(item?.reason, 300) || 'absorbed' });
  }
  const links = [];
  const seenLinks = new Set();
  for (const item of [...(Array.isArray(raw.links) ? raw.links : []), ...bodyLinks]) {
    if (links.length >= maxLinks) break;
    const from = safeFile(item?.from);
    const to = safeFile(item?.to);
    if (from === '' || to === '' || from === to || seenLinks.has(`${from}\u0000${to}`)) continue;
    seenLinks.add(`${from}\u0000${to}`);
    links.push({ from, to });
  }
  const conflicts = [];
  for (const item of Array.isArray(raw.conflicts) ? raw.conflicts : []) {
    if (conflicts.length >= maxConflicts) break;
    const file = safeFile(item?.file);
    const content = oneLine(item?.content, 2000);
    if (file === '' || content === '') continue;
    conflicts.push({ file, content });
  }
  return {
    summary: oneLine(raw.summary, 2000),
    writes,
    deletes,
    links,
    conflicts,
    index: text(raw.index).trim(),
    skill: text(raw.skill).trim(),
  };
}

/** Parse one organizer reply end to end. */
export function parseOrganizerReply(reply, options = {}) {
  const parsed = extractJsonObject(reply);
  if (!parsed) return null;
  return normalizeOrganizerReply(parsed, options);
}

/**
 * Deterministic fallback index/skill from the final pages. Used when the model
 * omits them, or as a validation comparison.
 */
export function composeIndexAndSkill(pages, { title = 'Project memory', description = '' } = {}) {
  const metas = pages.map((page) => pageMeta({ file: page.file, data: page, body: page.body, raw: page.body }));
  const index = buildIndex({ pages: metas, style: 'memory', title: '', groupBy: 'type' });
  const domains = [...new Set(metas.map((page) => page.domain).filter(Boolean))].sort();
  const skill = buildSkill({ title, description, domains, style: 'memory' });
  return { index, skill };
}
