/**
 * Claude Code memory interoperability (v10).
 *
 * Import: read a Claude Code style memory directory (`memory/MEMORY.md` plus
 * topic `.md` files; a bare directory with `.md` files also works) and write
 * the entries into this project's memory store. Export: create the same layout
 * from this project's memory plus a `.claude/rules` copy of the rules file.
 *
 * Everything goes through the normal store write path, so provenance, secret
 * scanning, index maintenance and size limits still apply.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const INDEX_LINE = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]?\s*(.*)$/;

/** Slash commands get the raw text, so no shell has expanded `~` by now. */
function expandHome(value) {
  return /^~(?=$|[/\\])/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
}

function normalizeType(value) {
  return MEMORY_TYPES.includes(value) ? value : 'reference';
}

function firstLine(text, max = 120) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  return line ? line.slice(0, max) : '';
}

function parseIndex(text) {
  const entries = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = INDEX_LINE.exec(line.trim());
    if (!match) continue;
    entries.set(match[2], { name: match[1], description: (match[3] ?? '').trim() });
  }
  return entries;
}

async function listMarkdown(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md').sort();
  } catch {
    return [];
  }
}

async function sourceLayout(sourceDir) {
  const nested = path.join(sourceDir, 'memory');
  try {
    const stat = await fs.stat(nested);
    if (stat.isDirectory()) return { memoryDir: nested, indexFile: path.join(nested, 'MEMORY.md') };
  } catch {
    /* no nested memory dir */
  }
  return { memoryDir: sourceDir, indexFile: path.join(sourceDir, 'MEMORY.md') };
}

/**
 * @param {{paths:object, sourceDir:string, store:object}} input
 * @returns {Promise<{ok:boolean, imported:Array, skipped:Array, errors:Array}>}
 */
export async function importClaudeMemory({ paths, sourceDir, store } = {}) {
  const dir = typeof sourceDir === 'string' ? expandHome(sourceDir.trim()) : '';
  if (dir === '') return { ok: false, error: 'invalid-source', imported: [], skipped: [], errors: [] };
  let layout;
  try {
    layout = await sourceLayout(dir);
    await fs.access(layout.memoryDir);
  } catch {
    return { ok: false, error: 'source-not-found', imported: [], skipped: [], errors: [] };
  }
  let index = new Map();
  try {
    index = parseIndex(await fs.readFile(layout.indexFile, 'utf8'));
  } catch {
    /* no index: fall back to filenames */
  }
  const existing = new Set();
  try {
    const entries = await store.listEntries('project');
    for (const entry of entries) existing.add(entry.file);
  } catch {
    /* listing is best-effort */
  }
  const imported = [];
  const skipped = [];
  const errors = [];
  for (const file of await listMarkdown(layout.memoryDir)) {
    if (existing.has(file)) {
      skipped.push({ file, reason: 'already exists' });
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(layout.memoryDir, file), 'utf8');
      const parsed = parseFrontmatter(raw);
      const front = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
      const hint = index.get(file) ?? { name: '', description: '' };
      const name = (typeof front.name === 'string' && front.name.trim()) || hint.name || file.replace(/\.md$/i, '');
      const body = String(parsed.body ?? '').trim();
      const description =
        (typeof front.description === 'string' && front.description.trim()) || hint.description || firstLine(body);
      const type = normalizeType(front.type);
      await store.writeRawEntry(file, {
        scope: 'project',
        type,
        name,
        description,
        body: body === '' ? name : body,
        source: { via: 'import:claude' },
      });
      imported.push(file);
      existing.add(file);
    } catch (error) {
      errors.push({ file, message: error?.message ?? String(error) });
    }
  }
  return { ok: true, imported, skipped, errors, sourceDir: layout.memoryDir };
}

/**
 * @param {{paths:object, targetDir:string, store:object}} input
 * @returns {Promise<{ok:boolean, exported:Array, targetDir:string, rules:boolean}>}
 */
export async function exportClaudeMemory({ paths, targetDir, store } = {}) {
  const dir = typeof targetDir === 'string' ? expandHome(targetDir.trim()) : '';
  if (dir === '') return { ok: false, error: 'invalid-target', exported: [], targetDir: '', rules: false };
  const memoryDir = path.join(dir, 'memory');
  await fs.mkdir(memoryDir, { recursive: true });
  const entries = await store.listEntries('project');
  const indexLines = [];
  const exported = [];
  for (const entry of entries) {
    try {
      const parsed = await store.readEntry(entry.file, 'project');
      const front = parsed && parsed.frontmatter && typeof parsed.frontmatter === 'object' ? parsed.frontmatter : {};
      const body = String(parsed?.body ?? '').trim();
      const name = typeof front.name === 'string' && front.name !== '' ? front.name : entry.name;
      const description =
        typeof front.description === 'string' && front.description !== '' ? front.description : entry.description;
      const type = normalizeType(front.type ?? entry.type);
      const raw = stringifyFrontmatter(
        { name, description, type, modified: typeof front.modified === 'string' ? front.modified : '' },
        body === '' ? description : body,
      );
      await fs.writeFile(path.join(memoryDir, entry.file), raw, 'utf8');
      indexLines.push(`- [${name}](${entry.file}) — ${description}`);
      exported.push(entry.file);
    } catch {
      /* skip unreadable entries, keep exporting the rest */
    }
  }
  await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), `${indexLines.join('\n')}\n`, 'utf8');
  let rules = false;
  const candidates = [paths?.projectRulesFile, paths?.globalRulesFile].filter((value) => typeof value === 'string');
  const ruleTexts = [];
  for (const candidate of candidates) {
    try {
      const text = (await fs.readFile(candidate, 'utf8')).trim();
      if (text !== '') ruleTexts.push(text);
    } catch {
      /* optional rule file */
    }
  }
  if (ruleTexts.length > 0) {
    const rulesDir = path.join(dir, '.claude', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, 'dsh-memory.md'), `${ruleTexts.join('\n\n')}\n`, 'utf8');
    rules = true;
  }
  return { ok: true, exported, targetDir: memoryDir, rules };
}
