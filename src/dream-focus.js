/**
 * The host-built focus list for automatic Dream maintenance.
 *
 * Corrected notes and broken source anchors qualify. Recall helps rank those
 * targets. Session review has its own scheduling path.
 */
import { checkSources } from './sources.js';
import { readMetrics } from './metrics.js';
import { mapNoteFiles } from './store.js';
import { memoryHash } from './write-review.js';
import { scanSecrets } from './secrets.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS = { corrected: 8, broken: 5 };
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

/** Select maintenance targets whose current inputs have not been reviewed. */
export async function buildFocus(pctx) {
  const [entries, metrics] = await Promise.all([pctx.store.listEntries('project'), readMetrics(pctx.paths)]);
  return focusFrom(pctx, entries, metrics, pctx.state.snapshot());
}

async function focusFrom(pctx, entries, metrics, snapshot) {
  const corrected = new Set(snapshot.correctedFiles);
  const recentRecalls = ({ file }) => {
    const row = metrics.entries[file];
    return row?.lastRecallAt > snapshot.lastDreamAt ? row.recalls : 0;
  };
  const byRecall = (a, b) => recentRecalls(b) - recentRecalls(a);
  const cited = entries.filter((entry) => !corrected.has(entry.file) && entry.sources?.length).sort(byRecall);
  const broken = await mapNoteFiles(cited.slice(0, MAX_SOURCE_CHECKS), async (entry) => {
    const check = await checkSources(pctx.paths.projectRoot, entry.sources, { withRevision: true });
    return check.broken.length ? { entry, check, reason: 'broken' } : undefined;
  });
  const targets = [
    ...entries.filter(({ file }) => corrected.has(file)).sort(byRecall).map((entry) => ({ entry, reason: 'corrected' })),
    ...broken,
  ];
  const counts = { corrected: 0, broken: 0 };
  const selected = [];
  for (const { entry, reason, check } of targets) {
    if (counts[reason] >= LIMITS[reason]) continue;
    const { file } = entry;
    const note = await pctx.store.readEntry(file).catch(() => null);
    if (!note || note.revision !== entry.revision) continue;
    const sources = check ?? await checkSources(pctx.paths.projectRoot, entry.sources, { withRevision: true });
    const version = memoryHash(note.raw);
    const key = memoryHash(JSON.stringify([version, snapshot.correctionVersions?.[file], sources.items]));
    if (snapshot.dreamMaintenance?.[file] === key) continue;
    selected.push({ file, reason, version, key, brokenSources: sources.broken });
    counts[reason] += 1;
  }
  const files = selected.map(({ file, reason }) => ({ file, reason }));
  const parts = selected.map(({ file, reason, brokenSources }) => {
    const [first] = brokenSources;
    const correction = reason === 'corrected' ? 'user correction' : '';
    const anchor = first && (scanSecrets(first.source).matches.length ? '[redacted anchor]' : JSON.stringify(first.source.slice(0, 120)));
    const failed = first ? `source anchor ${anchor} reported ${first.status}` + (brokenSources.length > 1 ? `, plus ${brokenSources.length - 1} more` : '') : '';
    return `- ${file}: ${[correction, failed].filter(Boolean).join('. ')}`;
  });
  const text = files.length === 0 ? '' : `For maintenance, check these notes in priority order. Anchor failures are lookup results. Verify the fact and its scope before changing or retiring it. If the task has a source session, also preserve its durable new facts.\n${parts.join('\n')}`;
  return { files, text, maintenance: selected.map(({ file, version, key }) => ({ file, version, key })) };
}

const SUSPECT_LIMITS = { dismissed: 8, archive: 8 };

/**
 * The notes Dream is told to look at first, from signals the host has: a user
 * correction since the last Dream, a source anchor that no longer resolves, a
 * dismissal in recall ("Not relevant"), or no read or recall for a long time.
 * The host does not judge whether a note is wrong; each entry says why it is
 * listed and which session the note came from, if it names one.
 * @returns {Promise<Array<{file:string, reasons:string[], sourceSession:string}>>}
 */
export async function buildSuspects(pctx, config = {}) {
  const [entries, metrics] = await Promise.all([pctx.store.listEntries('project'), readMetrics(pctx.paths)]);
  const snapshot = pctx.state.snapshot();
  const focus = await focusFrom(pctx, entries, metrics, snapshot);
  const byFile = new Map(entries.map((entry) => [entry.file, entry]));
  const suspects = new Map();
  const add = (file, reason) => {
    if (!byFile.has(file)) return;
    suspects.set(file, [...(suspects.get(file) ?? []), reason]);
  };
  for (const { file, reason } of focus.files) {
    add(file, reason === 'corrected' ? 'the user corrected it since the last Dream' : 'a source anchor in its frontmatter no longer resolves');
  }
  const dismissed = new Set(Object.values(snapshot.recallDismissals ?? {}).flat()
    .filter((ref) => typeof ref === 'string' && ref.startsWith('project/')).map((ref) => ref.slice('project/'.length)));
  [...dismissed].slice(-SUSPECT_LIMITS.dismissed).forEach((file) => add(file, 'the user dismissed it in recall as not relevant'));
  const days = config.archiveHintDays;
  archiveCandidates(entries, metrics, days).slice(0, SUSPECT_LIMITS.archive)
    .forEach(({ file, idleDays }) => add(file, `not read or recalled for ${idleDays} days`));
  return [...suspects].map(([file, reasons]) => ({ file, reasons, sourceSession: byFile.get(file).sourceSession || '' }));
}
