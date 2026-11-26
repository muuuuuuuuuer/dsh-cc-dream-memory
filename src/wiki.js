/**
 * Wiki pages: the layer only Dream writes.
 *
 * A page is a flat `wiki_<slug>.md` file with `type: wiki` that synthesizes
 * several notes and sessions and links related pages and notes with
 * `[[file-name]]`. The host guards the hard boundaries here (links that
 * resolve, page and total size) and reports them back to the model; what a page
 * should say is the model's call.
 *
 * @module dsh-cc-dream-memory/wiki
 */
import { DEFAULTS } from './config.js';
import { currentBody, memoryBodyLines } from './memory-body.js';
import { WIKI_PREFIX, isWikiFile, mapNoteFiles } from './store.js';

const LINK_RE = /\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\]/gu;

/**
 * The `[[targets]]` of a body, outside code fences and history (`- Superseded:`
 * lines and anything under `## History`): a page no longer links a file once the
 * link moved into history, so deleting that file must not be blocked by it.
 */
export function wikiLinks(body) {
  const targets = new Set();
  for (const { line, fenced } of memoryBodyLines(currentBody(body))) {
    if (fenced) continue;
    for (const match of line.matchAll(LINK_RE)) targets.add(match[1].trim());
  }
  return [...targets];
}

/** The file a link names: `[[feedback_x]]` and `[[feedback_x.md]]` are one file, `[[x]]` may be `wiki_x.md`. */
export function resolveWikiLink(target, files) {
  const stem = String(target).trim().replace(/\.md$/iu, '');
  return [`${stem}.md`, `${WIKI_PREFIX}${stem}.md`].find((file) => files.has(file)) ?? '';
}

/** Limits from the config, with the defaults for a config that predates them. */
export function wikiLimits(config) {
  return {
    page: Number(config?.wikiPageMaxChars) > 0 ? Number(config.wikiPageMaxChars) : DEFAULTS.wikiPageMaxChars,
    total: Number(config?.wikiTotalMaxChars) > 0 ? Number(config.wikiTotalMaxChars) : DEFAULTS.wikiTotalMaxChars,
  };
}

/**
 * What the wiki holds now: page count, characters of page bodies, and the
 * bodies themselves (for link checks).
 * @param {import('./store.js').MemoryStore} store
 * @returns {Promise<{pages:number, chars:number, bodies:Map<string,string>}>}
 */
export async function wikiUsage(store, files) {
  const names = files ?? (await store.listEntries('project')).map(({ file }) => file);
  const pages = await mapNoteFiles([...names].filter(isWikiFile), async (file) => {
    const body = (await store.readEntry(file, 'project').catch(() => null))?.body ?? '';
    return [file, body];
  });
  return { pages: pages.length, chars: pages.reduce((sum, [, body]) => sum + body.length, 0), bodies: new Map(pages) };
}

/** One line the model sees with every submit and in the prompt. */
export function wikiUsageLine(usage, config) {
  const { page, total } = wikiLimits(config);
  return `Wiki: ${usage.pages} page(s), ${usage.chars} of ${total} chars used; one page holds at most ${page} chars.`;
}

export function affectsWikiLinks(files, changes) {
  return changes.some(({ file }) => isWikiFile(file))
    || (changes.some(({ op }) => op === 'delete') && [...files].some(isWikiFile));
}

/**
 * Size problems of one page write: the page cap, and the total budget when the
 * write grows the wiki (a shrinking write is always allowed).
 * @returns {string} the reason, or '' when the write fits.
 */
export function wikiSizeProblem({ body, previousChars = 0, usage, config }) {
  const { page, total } = wikiLimits(config);
  if (body.length > page) {
    return `this page is ${body.length} chars; a page holds at most ${page}. Shorten it, or split the topic into pages that link each other.`;
  }
  const after = usage.chars - previousChars + body.length;
  if (after > total && body.length > previousChars) {
    return `the wiki would hold ${after} chars; the budget is ${total} (now ${usage.chars}). A page must be shorter than what it replaces: shorten this one, or delete or merge another page first.`;
  }
  return '';
}

/**
 * Problems of one submit call that no single write can see: links in new page
 * text must resolve once the whole call is applied, and a file the call
 * deletes must not leave a page with a dead link.
 * @param {{store:object, files:Set<string>, changes:Array<{file:string, op:string, body?:string}>}} input
 * @returns {Promise<string[]>} one line per problem.
 */
export async function wikiBatchProblems({ store, files: before, changes }) {
  const files = new Set(before);
  const deleted = new Set(changes.filter(({ op }) => op === 'delete').map(({ file }) => file));
  for (const { file, op } of changes) if (op !== 'delete') files.add(file);
  for (const file of deleted) files.delete(file);
  const problems = [];
  for (const { file, op, body } of changes) {
    if (op !== 'write' || !isWikiFile(file)) continue;
    const broken = wikiLinks(body).filter((target) => !resolveWikiLink(target, files));
    if (broken.length > 0) {
      problems.push(`${file}: broken link(s) ${broken.map((target) => `[[${target}]]`).join(', ')}: no page or note with that file name exists after this call. Link a file name without .md, e.g. [[feedback_testing]].`);
    }
  }
  if (deleted.size > 0) {
    const { bodies } = await wikiUsage(store, before);
    // A page the call rewrites in full is checked above; every other page keeps its old text.
    const rewritten = new Set(changes.filter(({ op }) => op === 'write').map(({ file }) => file));
    const linkers = new Map();
    for (const [page, text] of bodies) {
      if (deleted.has(page) || rewritten.has(page)) continue;
      for (const target of wikiLinks(text)) {
        const file = resolveWikiLink(target, before);
        if (!deleted.has(file)) continue;
        if (!linkers.has(file)) linkers.set(file, new Set());
        linkers.get(file).add(page);
      }
    }
    for (const [file, pages] of linkers) {
      problems.push(`${file}: cannot be deleted while ${[...pages].join(', ')} link(s) to it. Edit those pages to drop or retarget the link.`);
    }
  }
  return problems;
}
