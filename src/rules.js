/**
 * Editable memory rules.
 *
 * Claude Code parity: nothing is injected by default — the first turn carries
 * the index and three tool names, not a behaviour manual. A project may still
 * keep its own guidance in `memory-rules.md` (the CLAUDE.md analogue); that
 * file is what gets injected, and only when it exists.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** No built-in block: the index is the whole memory surface on the first turn. */
export const DEFAULT_RULES = '';

/** Upper bound accepted for one rules override (characters). */
export const RULES_MAX_CHARS = 8000;

function readIfPresent(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Resolve the rules actually injected for one project.
 * @param {{projectRulesFile:string, globalRulesFile:string}} paths
 * @param {{maxChars?:number}} [options]
 * @returns {{text:string, source:'project'|'global'|'default', projectPath:string,
 *   globalPath:string, maxChars:number, truncated:boolean}}
 */
export function loadRules(paths, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(1, Math.trunc(options.maxChars)) : RULES_MAX_CHARS;
  const projectPath = typeof paths?.projectRulesFile === 'string' ? paths.projectRulesFile : '';
  const globalPath = typeof paths?.globalRulesFile === 'string' ? paths.globalRulesFile : '';
  const projectText = projectPath === '' ? '' : readIfPresent(projectPath);
  const globalText = globalPath === '' ? '' : readIfPresent(globalPath);
  const selected = projectText !== '' ? 'project' : globalText !== '' ? 'global' : 'default';
  const raw =
    selected === 'project' ? projectText : selected === 'global' ? globalText : DEFAULT_RULES;
  const truncated = raw.length > maxChars;
  return {
    text: truncated ? raw.slice(0, maxChars) : raw,
    source: selected,
    projectPath,
    globalPath,
    maxChars,
    truncated,
  };
}

/** Delete one override file; a missing file is not an error. */
async function clearRulesFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  try {
    await fsp.unlink(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Atomically write one override file; empty text clears the override. */
export async function saveRulesFile(file, text) {
  if (typeof file !== 'string' || file === '') throw new Error('no rules file path');
  const value = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (value === '') return clearRulesFile(file);
  if (value.length > RULES_MAX_CHARS) {
    const error = new Error(`rules are ${value.length} characters, the limit is ${RULES_MAX_CHARS}`);
    error.code = 'RULES_TOO_LONG';
    throw error;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(temporary, `${value}\n`, 'utf8');
  await fsp.rename(temporary, file);
  return true;
}
