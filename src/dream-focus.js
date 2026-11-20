/**
 * The host-built focus list for an automatic Dream.
 *
 * Field runs showed that a Dream given an explicit target succeeds, while an
 * open-ended one proposes rewrites the evidence gate rejects. So the automatic
 * Dream only runs when the host can name what to look at, in priority order:
 *   1. notes the user corrected in a live session since the last Dream switch;
 *   2. notes whose `sources` no longer resolve;
 *   3. notes recalled since the last Dream, most recalled first;
 *   4. archive candidates (unread and unrecalled for `archiveHintDays`).
 * An empty list means there is nothing to consolidate and the Dream is skipped.
 * Manual runs never go through this module.
 */
import { checkSources } from './sources.js';
import { normalizeMetrics, readMetrics } from './metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = { corrected: 8, broken: 5, recalled: 5, archive: 5 };
/** Notes whose sources are checked per focus build. */
const MAX_SOURCE_CHECKS = 50;

/**
 * Notes neither read nor recalled for `days`, and not written for `days` either.
 * Nothing is deleted; the list only hints at what could be archived.
 * @param {Array<{file:string, modified?:string}>} entries
 * @param {object} metrics normalized metrics
 * @returns {Array<{file:string, idleDays:number}>} longest idle first.
 */
export function archiveCandidates(entries, metrics, days, now = Date.now()) {
  const limit = Math.max(1, Number(days) || 60) * DAY_MS;
  const rows = metrics?.entries ?? {};
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = rows[entry.file] ?? {};
    const written = Date.parse(entry.modified ?? '');
    const last = Math.max(Number(row.lastReadAt) || 0, Number(row.lastRecallAt) || 0, Number.isFinite(written) ? written : 0);
    // A note with no timestamp at all has no age to judge.
    if (last > 0 && now - last > limit) candidates.push({ file: entry.file, idleDays: Math.floor((now - last) / DAY_MS) });
  }
  return candidates.sort((a, b) => b.idleDays - a.idleDays || a.file.localeCompare(b.file));
}

/** Notes whose `sources` do not all resolve, with the broken source names. */
export async function brokenSourceNotes(root, entries) {
  const broken = [];
  for (const entry of (Array.isArray(entries) ? entries : []).filter((item) => item.sources?.length > 0).slice(0, MAX_SOURCE_CHECKS)) {
    const check = await checkSources(root, entry.sources);
    if (check.broken.length > 0) broken.push({ file: entry.file, sources: check.broken.map((item) => item.source) });
  }
  return broken;
}

/**
 * Build the focus list for one project.
 * @param {{state:object, store:object, paths:object}} pctx
 * @param {{archiveHintDays?:number}} config
 * @returns {Promise<{files:Array<{file:string, reason:string}>, text:string}>}
 */
export async function buildFocus(pctx, config = {}, now = Date.now()) {
  const entries = await pctx.store.listEntries('project');
  const existing = new Set(entries.map((entry) => entry.file));
  const snapshot = pctx.state.snapshot();
  const metrics = normalizeMetrics(await readMetrics(pctx.paths));
  const picked = new Map();
  const add = (reason, files, limit) => {
    for (const file of files) {
      if (picked.size >= 30 || picked.has(file) || [...picked.values()].filter((item) => item === reason).length >= limit) continue;
      picked.set(file, reason);
    }
  };
  add('corrected', snapshot.correctedFiles.filter((file) => existing.has(file)), LIMITS.corrected);
  add('broken', (await brokenSourceNotes(pctx.paths.projectRoot, entries)).map((item) => item.file), LIMITS.broken);
  const recalled = entries
    .filter((entry) => (metrics.entries[entry.file]?.lastRecallAt ?? 0) > snapshot.lastDreamAt)
    .sort((a, b) => (metrics.entries[b.file].recalls ?? 0) - (metrics.entries[a.file].recalls ?? 0) || a.file.localeCompare(b.file));
  add('recalled', recalled.map((entry) => entry.file), LIMITS.recalled);
  add('archive', archiveCandidates(entries, metrics, config.archiveHintDays, now).map((item) => item.file), LIMITS.archive);
  const files = [...picked].map(([file, reason]) => ({ file, reason }));
  const names = (reason) => files.filter((item) => item.reason === reason).map((item) => item.file).join(', ');
  const parts = [
    ['corrected', 'the user corrected something these notes say since the last Dream; make sure each note now states only what is true'],
    ['broken', 'the sources these notes cite have changed or are gone; check them against the repository and fix or drop what no longer holds'],
    ['recalled', 'recalled most since the last Dream; check they are accurate and concise'],
    ['archive', 'lowest priority: not read or recalled for a long time; merge or retire only what is clearly obsolete'],
  ].filter(([reason]) => names(reason) !== '').map(([reason, note]) => `- ${names(reason)}: ${note}`);
  return { files, text: files.length === 0 ? '' : `Work only on these notes, in this priority order; leave every other note alone.\n${parts.join('\n')}` };
}
