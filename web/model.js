import { asNumber, errorKey } from './normalize.js';
import { formatError } from './format.js';

/** Types a person may write; wiki pages are written by Dream only. */
export const NOTE_TYPES = ['user', 'feedback', 'project', 'reference'];
export const MEMORY_TYPES = [...NOTE_TYPES, 'wiki'];

export const TRUST_FILTERS = ['verified', 'unverified', 'stale'];

export const STATUS_NAMES = ['stale', 'superseded', 'disputed', 'review-needed', 'retired'];

const TYPE_COLORS = {
  user: 'var(--dsw-alias-trajectory-accent,#3b82f6)',
  feedback: 'var(--dsw-alias-state-warn-primary,#f59e0b)',
  project: 'var(--dsw-alias-state-success-primary,#22c55e)',
  reference: 'var(--dsw-alias-chart-tools,#8b5cf6)',
  wiki: 'var(--dsw-alias-state-info-primary,#0ea5e9)',
};

const BACKSLASH = String.fromCharCode(92);

export function knownType(type) {
  return MEMORY_TYPES.includes(type) ? type : 'user';
}

export function typeStyle(type) {
  return { '--ccm-type': TYPE_COLORS[knownType(type)] };
}

/** Milliseconds from a number or an ISO string (0 when unknown). */
export function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const parsed = Date.parse(String(value === undefined || value === null ? '' : value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `3 min ago` / `2 天前`; '' when the time is unknown. */
export function ago(value, t) {
  const ms = timeOf(value);
  if (ms === 0) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return t('time.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('time.hours', { n: hours });
  return t('time.days', { n: Math.round(hours / 24) });
}

/** `12345` → `12,345` (locale grouping when available). */
export function formatNumber(value) {
  const number = asNumber(value, 0);
  try {
    return number.toLocaleString('en-US');
  } catch {
    return String(number);
  }
}

function sortEntries(list) {
  // Wiki pages lead, as they do in the index.
  const rank = (entry) => (entry.type === 'wiki' ? 1 : 0);
  return [...list].sort(
    (left, right) => rank(right) - rank(left) || timeOf(right.modified) - timeOf(left.modified) || left.name.localeCompare(right.name),
  );
}

/** `{all, user, feedback, project, reference, wiki}` counts for the filter chips. */
export function countByType(entries) {
  const counts = { all: 0, user: 0, feedback: 0, project: 0, reference: 0, wiki: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    counts.all += 1;
    if (MEMORY_TYPES.includes(entry && entry.type)) counts[entry.type] += 1;
  }
  return counts;
}

export function trustOf(entry) {
  const record = entry && typeof entry === 'object' ? entry : {};
  if (record.current === false) return 'stale';
  if (record.verified && typeof record.verified === 'object') return 'verified';
  if (record.verifiedOutdated === true) return 'changed';
  return 'unverified';
}

/** Trust filter: `verified` includes loaded notes, `unverified` includes edited ones. */
export function matchesTrust(entry, filter) {
  if (!TRUST_FILTERS.includes(filter)) return true;
  const trust = trustOf(entry);
  if (filter === 'unverified') return trust === 'unverified' || trust === 'changed';
  return trust === filter;
}

/** `{all, hot, verified, unverified, stale}` counts for the trust filter. */
export function countByTrust(entries) {
  const counts = { all: 0, hot: 0, verified: 0, unverified: 0, stale: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    counts.all += 1;
    for (const filter of TRUST_FILTERS) if (matchesTrust(entry, filter)) counts[filter] += 1;
  }
  return counts;
}

export function filterEntries(entries, options = {}) {
  const type = MEMORY_TYPES.includes(options.type) ? options.type : '';
  const trust = TRUST_FILTERS.includes(options.trust) ? options.trust : '';
  const needle = String(options.query === undefined || options.query === null ? '' : options.query)
    .trim()
    .toLowerCase();
  const hits = options.hits && typeof options.hits.get === 'function' ? options.hits : new Map();
  const pool = (Array.isArray(entries) ? entries : []).filter(
    (entry) => (type === '' || entry.type === type) && (trust === '' || matchesTrust(entry, trust)),
  );
  if (needle === '') return sortEntries(pool);
  const terms = needle.split(/\s+/).filter(Boolean);
  const ranked = [];
  for (const entry of pool) {
    const haystack = (entry.name + '\n' + entry.description + '\n' + entry.file).toLowerCase();
    const local = terms.every((term) => haystack.includes(term));
    const hit = hits.get(entry.file);
    if (!local && !hit) continue;
    const score =
      (entry.name.toLowerCase().includes(needle) ? 10 : 0) + (local ? 5 : 0) + (hit ? asNumber(hit.score, 0) : 0);
    ranked.push({ entry, score });
  }
  ranked.sort(
    (left, right) => right.score - left.score || timeOf(right.entry.modified) - timeOf(left.entry.modified),
  );
  return ranked.map((item) => item.entry);
}

const NOTE_KEYS = {
  'APPLIES WHEN': 'appliesWhen',
  'HOW TO VERIFY': 'verify',
  VERIFY: 'verify',
  OBSERVED: 'observed',
  EXCEPTION: 'exception',
};

/**
 * Split a memory body into what the reader shows separately: the `STATUS:`
 * marker, condition notes (APPLIES WHEN / VERIFY / OBSERVED / EXCEPTION),
 * `CONFLICT:` lines, earlier values (`- Superseded:` lines and a
 * `## History` section) and the remaining Markdown. Stamp lines
 * (VERIFIED, VERIFIED AGAINST, USER CONFIRMED, CONFIRMED) are dropped: the
 * host ledger, not a typed line, decides what is verified.
 */
export function splitBody(body) {
  const lines = String(body === undefined || body === null ? '' : body).replace(/\r\n/g, '\n').split('\n');
  const out = { status: '', notes: [], conflicts: [], superseded: [], rest: '' };
  const rest = [];
  let fence = false;
  let inHistory = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      fence = !fence;
      if (!inHistory) rest.push(line);
      continue;
    }
    if (fence) {
      if (!inHistory) rest.push(line);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inHistory = /^history\s*$/i.test(heading[1].trim());
      if (!inHistory) rest.push(line);
      continue;
    }
    if (inHistory) {
      const value = line.replace(/^\s*[-*]\s+/, '').replace(/^Superseded:\s*/i, '').trim();
      if (value !== '') out.superseded.push(value);
      continue;
    }
    const status = /^\s*STATUS:\s*([A-Za-z-]+)/.exec(line);
    if (status) {
      out.status = status[1].toLowerCase();
      continue;
    }
    if (/^\s*(VERIFIED AGAINST|VERIFIED|USER CONFIRMED|CONFIRMED)\s*:/i.test(line)) continue;
    const note = /^\s*(APPLIES WHEN|HOW TO VERIFY|VERIFY|OBSERVED|EXCEPTION):\s*(.+)$/i.exec(line);
    if (note) {
      out.notes.push({ key: NOTE_KEYS[note[1].toUpperCase()] || 'verify', value: note[2].trim() });
      continue;
    }
    const superseded = /^\s*[-*]\s+Superseded:\s*(.+)$/i.exec(line);
    if (superseded) {
      out.superseded.push(superseded[1].trim());
      continue;
    }
    const conflict = /^\s*(?:[-*]\s+)?CONFLICT:\s*(.+)$/.exec(line);
    if (conflict) {
      out.conflicts.push(conflict[1].trim());
      continue;
    }
    rest.push(line);
  }
  out.rest = rest.join('\n').trim();
  return out;
}

/** create / update / delete / index for one previewed plan operation. */
export function opKind(op) {
  if (!op || typeof op !== 'object') return 'update';
  if (op.op === 'delete') return 'delete';
  if (op.op === 'index') return 'index';
  return op.before === '' ? 'create' : 'update';
}

/** Last path segment of a Windows or POSIX path. */
function baseName(value) {
  const parts = String(value === undefined || value === null ? '' : value)
    .split(BACKSLASH)
    .join('/')
    .split('/')
    .filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

export function projectLabel(project) {
  const record = project && typeof project === 'object' ? project : {};
  return baseName(record.projectRoot) || String(record.projectId || '') || baseName(record.memoryDir);
}

export function planWaiting(status) {
  const state = status && status.state ? status.state : {};
  return Boolean(state.pendingSwitch && state.pendingSwitch.dir);
}

/** One decision waiting for the user: an unreviewed Dream shadow. */
export function attentionCount(status) {
  return planWaiting(status) ? 1 : 0;
}

export function loadSummary(status, t) {
  if (!status) return null;
  const config = status.config;
  if (!config.enabled || !config.autoMemoryEnabled) return { tone: 'warn', icon: 'alert', text: t('load.off') };
  const maxLines = config.indexMaxLines || 200;
  if (status.index.overflow || status.index.lines > maxLines) {
    return { tone: 'warn', icon: 'alert', text: t('load.indexOver') };
  }
  return { tone: 'index', icon: 'book', text: t('load.index', { lines: status.index.lines, maxLines }) };
}

/** Friendly provenance: who wrote this memory. */
export function viaLabel(via, t) {
  const value = String(via || '');
  if (value === '') return '';
  if (value.startsWith('tool:')) return t('via.agent');
  if (value.startsWith('command:')) return t('via.command');
  if (value.startsWith('dream')) return t('via.tidy');
  if (value.startsWith('api:')) return t('via.you');
  if (value.startsWith('import')) return t('via.import');
  return value;
}

/** Map a thrown error (or a failure string) to a sentence for the toast. */
export function errorText(error, t) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  const message = formatError(error);
  const key = errorKey(code, message);
  if (key === 'locked') return t('err.locked');
  if (key === 'stale') return t('err.stale');
  if (key === 'deleteDisabled') return t('err.deleteDisabled');
  if (key === 'dreamTaskSession') return t('err.dreamTaskSession');
  if (key === 'pluginOff') return t('banner.pluginOff');
  if (key === 'autoMemoryOff') return t('banner.autoMemoryOff');
  if (key === 'backendStale') return t('err.backendStale');
  return message;
}

export function errorInfo(error, t) {
  const text = errorText(error, t);
  const raw = formatError(error);
  const evidence = /evidence[-_]rejected:\s*([\s\S]+)$/i.exec(raw);
  if (evidence) {
    const items = evidence[1]
      .split(/;\s+(?=[^\s:;]+[.]md: |index: |merge dependency)/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const file = /^([^\s:;]+[.]md): /.exec(item);
        return file ? file[1] + ' — ' + reasonText(item, file[1], t) : reasonText(item, '', t);
      });
    return { text: t('err.evidenceRejected'), items };
  }
  if (text.length > 140 && text.includes('; ')) {
    const colon = text.indexOf(': ');
    const head = colon > 0 && colon < 48 ? text.slice(0, colon) : '';
    const rest = head ? text.slice(colon + 2) : text;
    return { text: head, items: rest.split(/;\s+/).map((item) => item.trim()).filter(Boolean) };
  }
  return { text, items: [] };
}

/** A host refusal reason for one plan operation, in the user's language. */
export function reasonText(reason, file, t) {
  let value = String(reason || '');
  if (file && value.startsWith(file + ': ')) value = value.slice(file.length + 2);
  const quoted = (pattern) => {
    const match = pattern.exec(value);
    return match ? match[1] : '';
  };
  if (/^new line has no source citation/.test(value)) {
    return t('reason.noCitation', { line: quoted(/source citation: "([\s\S]*)"$/) });
  }
  if (/does not match any verified claim/.test(value)) return t('reason.noClaim');
  if (/^line is not supported by a verified claim/.test(value)) {
    return t('reason.unsupported', { line: quoted(/: "([\s\S]*)"$/) });
  }
  if (/attributes a requirement to the user/.test(value)) return t('reason.userAttribution');
  if (/user\/feedback line has no \[user\] claim/.test(value)) return t('reason.userClass');
  if (/^merge dependency/.test(value)) return t('reason.mergeDependency');
  return value;
}

/** One sentence for the auto-dream row, from the readiness gates. */
export function readinessText(readiness, config, t) {
  if (!readiness) return '';
  if (readiness.eligible) return t('tidy.ready');
  const reason = readiness.reasons.find((item) => item.code !== 'auto-dream-off' && item.code !== 'disabled');
  if (!reason) return '';
  if (reason.code === 'min-hours') return t('readiness.min-hours', { hours: config.minHours || 24 });
  if (reason.code === 'min-sessions') {
    const gate = readiness.gates.minSessions;
    return t('readiness.min-sessions', {
      current: gate ? gate.current : 0,
      required: gate ? gate.required : config.minSessions || 5,
    });
  }
  const key = 'readiness.' + reason.code;
  const text = t(key);
  return text !== key ? text : reason.message;
}
