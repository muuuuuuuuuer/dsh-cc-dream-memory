/**
 * Human-facing slash commands for dsh-cc-dream-memory.
 *
 * `/memory` inspects and operates the per-project memory directory, and
 * `/remember` saves one durable note. The Web view talks to the host through
 * the silent HTTP API; `/memory json` remains a stable, documented payload for
 * scripts and the command-mode fallback.
 *
 * This module imports Node builtins only: a workspace bundle cannot resolve
 * `@deepseek-ai/*` bare packages from its own `node_modules`.
 */
import fs from 'node:fs/promises';
import { VERSION } from './meta.js';
import { recordRead } from './metrics.js';
import { createStatusService, recordUserConfirmedSave } from './status.js';
import { ensureCurrentStatus } from './write-review.js';
import { applyProposals } from './auto-extract.js';
import { listProposals, readProposal, removeProposal } from './inbox.js';

/** Root command names, also accepted by `parseCommandLine` with a leading slash. */
const MEMORY_NAME = 'memory';
const REMEMBER_NAME = 'remember';

/** Supported frontmatter types for a hand-written memory note. */
const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);

/** Fast membership check for the supported frontmatter types. */
const TYPE_SET = new Set(MEMORY_TYPES);

const MEMORY_HINT =
  '[json|status|list|index|metrics|search <query>|show <file>|history <file>|edit <file> [--name/--type/--description/--content]|merge <file1> <file2> [...]|refresh|import <path>|export <path>|on|off|plugin on|off|delete <file>|rules [reset]|backups|trash|restore <backup|trash> <id> [file]|inbox list|inbox show <id>|inbox accept <id>|inbox discard <id>|dream on|off|dream status|dream estimate|dream history|dream undo|dream run [--focus <text>]|dream switch|dream discard]';
const REMEMBER_HINT = '[--type=user|feedback|project|reference] <text>';

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}


/** Build one successful command result. */
function ok(text) {
  return { kind: 'success', text: typeof text === 'string' ? text : String(text ?? '') };
}

/** Build one failed command result (never throw out of a handler). */
function fail(text) {
  return { kind: 'error', text: typeof text === 'string' ? text : String(text ?? 'command failed') };
}

/** Render any thrown value without trusting its string coercion. */
function errorText(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : '';
    if (typeof error.message === 'string' && error.message !== '') return `${code}${error.message}`;
  }
  try {
    return String(error);
  } catch {
    return 'unprintable error';
  }
}

// ---------------------------------------------------------------------------
// Argument parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Split a command argument string into tokens, honouring quotes and
 * backslash escapes while keeping each token's source range.
 * @param {string} raw
 * @returns {{value:string,start:number,end:number}[]}
 */
function tokenize(raw) {
  const tokens = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    const start = index;
    let value = '';
    let quote = '';
    while (index < raw.length) {
      const current = raw[index];
      if (quote !== '') {
        if (current === quote) {
          quote = '';
          index += 1;
          continue;
        }
        if (current === '\\' && index + 1 < raw.length) {
          value += raw[index + 1];
          index += 2;
          continue;
        }
        value += current;
        index += 1;
        continue;
      }
      if (current === '"' || current === "'") {
        quote = current;
        index += 1;
        continue;
      }
      if (current === ' ' || current === '\t' || current === '\n' || current === '\r') break;
      if (current === '\\' && index + 1 < raw.length) {
        value += raw[index + 1];
        index += 2;
        continue;
      }
      value += current;
      index += 1;
    }
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

/**
 * Parse the argument string a command handler receives into a verb and the
 * remaining tokens.
 *
 * The host hands a handler only the text after the command name, so
 * `parseCommandLine('dream run --dry-run')` reports `verb: 'dream'` and
 * `args: ['run', '--dry-run']`. A complete slash line is also accepted
 * (`'/memory json'`), which keeps the function convenient for tests and
 * callers that have the whole line.
 *
 * @param {unknown} rawInput
 * @returns {{verb: string, args: string[]}}
 */
export function parseCommandLine(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : '';
  const tokens = tokenize(raw).map((token) => token.value);
  const head = tokens[0] ?? '';
  const name = head.startsWith('/') ? head.slice(1) : head;
  if (name === MEMORY_NAME) return { verb: MEMORY_NAME, args: tokens.slice(1) };
  if (name === REMEMBER_NAME) return { verb: REMEMBER_NAME, args: tokens.slice(1) };
  return { verb: name.toLowerCase(), args: tokens.slice(1) };
}

/**
 * Parse a `/remember` argument string into the note payload: optional
 * `--type=` flag followed by the free-form text.
 *
 * The text is sliced from the original string so internal whitespace,
 * punctuation and newlines survive untouched.
 *
 * @param {unknown} rawInput
 * @returns {{type: string, text: string}}
 */
export function parseRememberInput(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const tokens = tokenize(raw);
  let type = 'user';
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].value;
    const match = /^--(type)(?:=(.*))?$/iu.exec(token);
    if (match === null) break;
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = tokens[index]?.value ?? '';
      index += 1;
    } else {
      index += 1;
    }
    type = value.toLowerCase();
  }
  const text = raw.slice(tokens[index]?.start ?? raw.length).trim();
  return { type, text };
}

/**
 * Split flag-like tokens (`--scope=user`, `--dry-run`) from positional ones.
 * A flag without `=` consumes the following token when it exists and does not
 * itself look like a flag; otherwise it becomes `true`.
 * @param {string[]} args
 * @returns {{flags: Record<string, string|true>, positional: string[]}}
 */
function splitFlags(args) {
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/iu.exec(arg);
    if (match === null) {
      positional.push(arg);
      continue;
    }
    const key = match[1].toLowerCase();
    if (match[2] !== undefined) {
      flags[key] = match[2];
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
      continue;
    }
    flags[key] = true;
  }
  return { flags, positional };
}

/**
 * Extract the raw argument following a verb from the original input, preserving
 * backslashes (Windows paths) that the shell-style tokenizer would otherwise
 * consume as escape characters. Quoted arguments keep everything up to the
 * closing quote; unquoted ones stop at the next flag.
 * @param {unknown} rawInput full command text handed to the handler
 * @param {string} verb command verb (`import`, `export`)
 * @returns {string}
 */
function rawArgumentAfter(rawInput, verb) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const pattern = new RegExp(`(?:^|\\s)${verb}\\s+`, 'u');
  const match = pattern.exec(raw);
  if (match === null) return '';
  let rest = raw.slice(match.index + match[0].length).trim();
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    return (end > 0 ? rest.slice(1, end) : rest.slice(1)).trim();
  }
  const flagIndex = rest.search(/\s+--/u);
  if (flagIndex >= 0) rest = rest.slice(0, flagIndex);
  return rest.trim();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Human byte size: `0 B`, `912 B`, `1.2 KB`, `3.4 MB`. */
/** Compact duration: `850ms`, `1.2s`, `1m 05s`. */
function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Tiny text bar for a daily metric count (0..10 blocks). */
function bar(value) {
  const count = Math.max(0, Math.min(10, Math.round(Number(value) || 0)));
  return count === 0 ? '·' : '█'.repeat(count);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO-8601 timestamp for a millisecond epoch, or `never`. */
function formatTime(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(value);
  }
}

/** Coarse age such as `3h ago` or `2.5d ago`. */
function formatAge(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d ago`;
}

/** Truncate one long single-line string for display. */
function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

/** First non-empty line of a text, shortened for a frontmatter description. */
function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimDescription(trimmed);
  }
  return '';
}

/** One-line frontmatter description at most 160 characters. */
function trimDescription(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (value.length <= 160) return value;
  return `${value.slice(0, 159).trimEnd()}…`;
}

/**
 * Deterministic note name from free text: the first line's first 32 characters
 * (Unicode kept as-is; the store slugifies it and suffixes duplicates). Empty
 * content falls back to `note`.
 */
function deriveName(text) {
  const first = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';
  const clipped = Array.from(first).slice(0, 32).join('').trim();
  return clipped === '' ? 'note' : clipped;
}

/** Normalise one store EntryMeta into the JSON payload shape. */
function normalizeEntry(entry) {
  const meta = entry && typeof entry === 'object' ? entry : {};
  return {
    file: typeof meta.file === 'string' ? meta.file : '',
    name: typeof meta.name === 'string' ? meta.name : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    type: typeof meta.type === 'string' ? meta.type : 'user',
    modified: typeof meta.modified === 'string' ? meta.modified : '',
    created: typeof meta.created === 'string' ? meta.created : '',
    sourceSession: typeof meta.sourceSession === 'string' ? meta.sourceSession : '',
    via: typeof meta.via === 'string' ? meta.via : '',
    bytes: Number(meta.bytes) || 0,
    lines: Number(meta.lines) || 0,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register `/memory` and `/remember` on the plugin context.
 *
 * Every handler resolves its project through the runtime (one memory directory
 * per workspace) and returns a `CommandResult`; no handler throws, so a broken
 * memory directory can never break the command surface.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{config: object, forAgent: Function, dream: Function, switchDream?: Function, discardDream?: Function,
 *   undoLastDream?: Function,
 *   setOverrides?: Function, overrides?: Function, rulesFor?: Function, invalidateInjection?: Function,
 *   invalidateAllInjections?: Function}} runtime
 * @returns {() => void} disposer that unregisters both commands.
 */
export function registerCommands(ctx, runtime) {
  const disposers = [];
  // The shared status service owns every project read/mutation so `/memory` and
  // the HTTP API cannot drift apart again.
  const service = createStatusService(runtime);
  // `commands` is an optional service for this plugin: resolve it through the
  // optional accessor so a Harness build without it degrades to "no slash
  // commands" instead of keeping the whole plugin inactive.
  const commandsService = ctx.get('commands');

  /**
   * Persist one field change through the profile config editor.
   * The editor restarts the plugin (ordinary field), so the new value becomes
   * effective only after the reload the result text mentions.
   * @param {Record<string, unknown>} patch
   * @returns {Promise<{ok:true}|{ok:false,error:string}>}
   */
  async function persistConfig(patch) {
    const entry = ctx?.fiber?.entry;
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
    if (entry === undefined || entry === null || !editor || typeof editor.edit !== 'function') {
      return {
        ok: false,
        error:
          'cannot persist: the profile config editor or this plugin entry is unavailable, so nothing was saved',
      };
    }
    try {
      await editor.edit(entry, (current) => ({
        ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        ...patch,
      }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `cannot persist: ${errorText(error)}` };
    }
  }

  /** Resolve this agent's project context, or throw one readable error. */
  async function requireProject(invocation) {
    const pctx = await runtime.forAgent(invocation?.agent);
    if (!pctx || !pctx.store || !pctx.paths) {
      throw new Error('the memory directory is unavailable for this session');
    }
    return pctx;
  }

  /** Gather every status fragment shared by `status`, `json` and `dream status`. */
  async function collectStatus(invocation) {
    try {
      const pctx = await requireProject(invocation);
      const payload = await service.status(pctx, { sessionId: invocation?.agent?.id });
      // Commands show the full effective config (dream gates included), while
      // the service payload keeps the narrower UI-facing config shape.
      const config =
        runtime.config;
      return {
        ok: true,
        pctx,
        payload,
        config,
        overrides: payload.overrides ?? {},
        rules: payload.rules,
        index: payload.index,
        entries: Array.isArray(payload.entries) ? payload.entries : [],
        snapshot: payload.state && typeof payload.state === 'object' ? payload.state : {},
        changelogTail: typeof payload.changelogTail === 'string' ? payload.changelogTail : '',
        trashCount: Number(payload.trashCount) || 0,
        metrics: payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : null,
        readiness: payload.readiness ?? null,
        inbox: payload.inbox && typeof payload.inbox === 'object' ? payload.inbox : { count: 0, items: [] },
        healthScore: Number.isFinite(Number(payload.healthScore)) ? Number(payload.healthScore) : null,
        subagentPolicy:
          payload.subagentPolicy && typeof payload.subagentPolicy === 'object'
            ? payload.subagentPolicy
            : {
                mode: config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
              },
        health: payload.health,
      };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /** Build the documented `/memory json` payload from a collected status. */
  function payloadOf(status) {
    const {
      pctx,
      config,
      overrides,
      rules,
      index,
      entries,
      snapshot,
      changelogTail,
      trashCount,
      metrics,
      readiness,
      healthScore,
      subagentPolicy,
    } = status;
    return {
      ok: true,
      project: {
        projectRoot: String(pctx.paths.projectRoot ?? ''),
        memoryDir: String(pctx.paths.memoryDir ?? ''),
      },
      config: {
        enabled: Boolean(config.enabled),
        autoMemoryEnabled: Boolean(config.autoMemoryEnabled),
        autoDreamEnabled: Boolean(config.autoDreamEnabled),
            minHours: Number(config.minHours) || 0,
        minSessions: Number(config.minSessions) || 0,
        indexMaxLines: Number(config.indexMaxLines) || 0,
        indexMaxBytes: Number(config.indexMaxBytes) || 0,
        dreamAllowDelete: Boolean(config.dreamAllowDelete),
        dreamMaxTotalTokens: Number(config.dreamMaxTotalTokens) || 0,
        policyDuplicateThreshold: Number(config.policyDuplicateThreshold) || 0.82,
        policySuggestThreshold: Number(config.policySuggestThreshold) || 0.55,
            dreamCostMode: config.dreamCostMode === 'review' || config.dreamCostMode === 'block' ? config.dreamCostMode : 'warn',
        projectId: typeof config.projectId === 'string' ? config.projectId : '',
        subagentMemory: config.subagentMemory === 'shared' || config.subagentMemory === 'own' ? config.subagentMemory : 'off',
      },
      index: {
        text: typeof index?.text === 'string' ? index.text : '',
        lines: Number(index?.lines) || 0,
        bytes: Number(index?.bytes) || 0,
        truncated: Boolean(index?.truncated),
        overflow: Boolean(index?.overflow),
      },
      entries: entries.map(normalizeEntry),
      state: {
        lastDreamAt: Number(snapshot.lastDreamAt) || 0,
        lastDreamAttemptAt: Number(snapshot.lastDreamAttemptAt) || 0,
        lastError: typeof snapshot.lastError === 'string' ? snapshot.lastError : '',
        lastDreamSummary: typeof snapshot.lastDreamSummary === 'string' ? snapshot.lastDreamSummary : '',
        lastDreamSessions: Number(snapshot.lastDreamSessions) || 0,
        lastDreamOps: Number(snapshot.lastDreamOps) || 0,
        lastDreamMode: typeof snapshot.lastDreamMode === 'string' ? snapshot.lastDreamMode : '',
            shadowPending: snapshot.shadowPending && typeof snapshot.shadowPending === 'object'
      ? { dir: String(snapshot.shadowPending.dir ?? ''), files: Array.isArray(snapshot.shadowPending.files) ? snapshot.shadowPending.files.length : 0 }
      : null,
        sessionsSince: Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince.length : 0,
        counters:
          snapshot.counters && typeof snapshot.counters === 'object' ? { ...snapshot.counters } : {},
      },
      trashCount: Number(trashCount) || 0,
      overrides: overrides && typeof overrides === 'object' ? { ...overrides } : {},
      rules: rules && typeof rules === 'object'
        ? {
            text: typeof rules.text === 'string' ? rules.text : '',
            source: typeof rules.source === 'string' ? rules.source : 'default',
            projectPath: typeof rules.projectPath === 'string' ? rules.projectPath : '',
            globalPath: typeof rules.globalPath === 'string' ? rules.globalPath : '',
            maxChars: Number(rules.maxChars) || 0,
          }
        : { text: '', source: 'unavailable', projectPath: '', globalPath: '', maxChars: 0 },
      metrics: metrics && typeof metrics === 'object' ? metrics : null,
      readiness: readiness && typeof readiness === 'object' ? readiness : null,
      healthScore: Number.isFinite(Number(healthScore)) ? Number(healthScore) : null,
      subagentPolicy:
        subagentPolicy && typeof subagentPolicy === 'object'
          ? {
              mode: subagentPolicy.mode === 'shared' || subagentPolicy.mode === 'own' ? subagentPolicy.mode : 'off',
              agentMemoryPresets: Array.isArray(subagentPolicy.agentMemoryPresets) ? subagentPolicy.agentMemoryPresets : [],
            }
          : { mode: 'off', agentMemoryPresets: [] },
      changelogTail: typeof changelogTail === 'string' ? changelogTail : '',
    };
  }

  /** Invalidate the prompt-injection cache after a memory mutation. */
  function invalidate(invocation) {
    try {
      const sessionId = invocation?.agent?.id;
      if (typeof sessionId === 'string') {
        runtime.invalidateInjection(sessionId);
      }
    } catch (error) {
      warn('invalidateInjection', error);
    }
  }

  /** Sort entries for stable display. */
  function sortedEntries(entries) {
    return [...entries].sort((left, right) => String(left.file).localeCompare(String(right.file)));
  }

  /**
   * v10: `/memory` write commands refuse delegated subagents when
   * `subagentMemory:'off'`. Returns a failed CommandResult or null.
   */
  function subagentGuard(invocation) {
    if (runtime.canWriteMemory(invocation?.agent)) return null;
    return fail('subagent-readonly: this subagent session cannot write memory under the current subagentMemory policy');
  }

  // -- /memory subcommands ---------------------------------------------------

  async function memoryStatus(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const { pctx, config, overrides, rules, index, entries, snapshot, trashCount } = status;
    const lines = [];
    lines.push(`cc-memory v${VERSION} — auto memory & dreaming`);
    lines.push(`project: ${pctx.paths.projectRoot || '(unknown)'}`);
    lines.push(`memory:  ${pctx.paths.memoryDir || '(unavailable)'}`);
    lines.push(
        `plugin: ${config.enabled ? 'enabled' : 'disabled'}   auto memory: ${config.autoMemoryEnabled ? 'ON' : 'OFF'}   auto dream: ${config.autoDreamEnabled ? 'ON' : 'OFF'}`,
    );
    const recallMode = config.recallMode === 'off' ? 'off' : 'model';
    lines.push(
      `recall: ${recallMode} (select ≤${Number(config.recallMaxCandidates) || 0} candidates; attach ≤${Number(config.autoRecallMaxFiles) || 0})`,
    );
    lines.push(
      `auto extract: ${config.autoExtract ? `inbox, every ${Number(config.autoExtractEveryTurns) || 1} turn(s)` : 'OFF'}   subagent memory: ${config.subagentMemory === 'off' ? 'OFF' : config.subagentMemory}${config.subagentMemory === 'own' && Array.isArray(config.agentMemoryPresets) && config.agentMemoryPresets.length > 0 ? ` (${config.agentMemoryPresets.join(', ')})` : ''}`,
    );
    if (overrides && Object.keys(overrides).length > 0) {
      lines.push(`runtime overrides: ${JSON.stringify(overrides)}  (GLOBAL · applies to every project; use /memory plugin on|off to change)`);
    }
    lines.push(
      `rules: ${rules?.source ?? 'unavailable'} (${String(rules?.text ?? '').length} chars)  project: ${rules?.projectPath || '-'}  global: ${rules?.globalPath || '-'}`,
    );
    lines.push(
      `index: ${Number(index?.lines) || 0}/${Number(config.indexMaxLines) || 0} lines, ${formatBytes(index?.bytes)}/${formatBytes(config.indexMaxBytes)}${index?.overflow ? ' — OVER BUDGET (the injected text is truncated)' : ''}`,
    );
    lines.push(
      `entries: ${entries.length}   trash: ${Number(trashCount) || 0} file(s)`,
    );
    if (Number.isFinite(Number(status.healthScore))) {
      lines.push(`memory health: ${Number(status.healthScore)}/100`);
    }
    if (status.readiness && typeof status.readiness === 'object') {
      const eligible = status.readiness.eligible === true;
      const nextAt = Number(status.readiness.nextEligibleAt) || 0;
      lines.push(
        `dream readiness: ${eligible ? 'eligible' : `blocked${nextAt > 0 ? `, next ${formatTime(nextAt)}` : ''}`}`,
      );
    }
    const metricsView = status.metrics;
    if (metricsView && typeof metricsView === 'object') {
      const injectCount = Number(metricsView.inject?.count) || 0;
      const reads = Number(metricsView.reads?.total) || 0;
      const writes = Number(metricsView.writes?.total) || 0;
      const searches = Number(metricsView.searches?.count) || 0;
      const adoptions = Number(metricsView.adoptions?.count) || 0;
      lines.push(
        `metrics: injections ${injectCount}   reads ${reads} (adopted ${adoptions})   writes ${writes}   searches ${searches}`,
      );
    }
    const policy = status.subagentPolicy;
    if (policy && typeof policy === 'object') {
      lines.push(
        `subagent memory: ${policy.mode === 'off' ? 'OFF' : policy.mode === 'own' ? 'own directory' : 'shared store'}${Array.isArray(policy.agentMemoryPresets) && policy.agentMemoryPresets.length > 0 ? ` (presets: ${policy.agentMemoryPresets.join(', ')})` : ''}`,
      );
    }
    const inboxCount = Number(status.inbox?.count) || 0;
    lines.push(
      `inbox: ${inboxCount} pending${inboxCount > 0 ? ' (/memory inbox list to review)' : ''}   last extract: ${formatTime(snapshot.lastExtractAt || snapshot.lastExtractAttemptAt)}${snapshot.lastExtractReason ? ` (${snapshot.lastExtractReason}${Number(snapshot.lastExtractCount) > 0 ? `, ${snapshot.lastExtractCount} note(s)` : ''})` : ''}${snapshot.lastExtractError ? ` — ${truncate(snapshot.lastExtractError, 160)}` : ''}`,
    );
    lines.push(
      `last dream: ${formatTime(snapshot.lastDreamAt)}${Number(snapshot.lastDreamAt) > 0 ? ` (${formatAge(snapshot.lastDreamAt)})` : ''}${Number(snapshot.lastDreamOps) > 0 ? `, ops: ${snapshot.lastDreamOps}` : ''}${typeof snapshot.lastDreamMode === 'string' && snapshot.lastDreamMode !== '' ? `, mode: ${snapshot.lastDreamMode}` : ''}`,
    );
    if (Number(snapshot.lastDreamSessions) > 0) {
      lines.push(`last dream sessions: ${snapshot.lastDreamSessions}`);
    }
    if (snapshot.shadowPending && typeof snapshot.shadowPending === 'object') {
      const files = Array.isArray(snapshot.shadowPending.files) ? snapshot.shadowPending.files.length : 0;
      lines.push(`pending dream result: ${files} file(s) to switch to (switch with /memory dream switch, discard with /memory dream discard)`);
    }
    if (typeof snapshot.lastDreamSummary === 'string' && snapshot.lastDreamSummary !== '') {
      lines.push(`last summary: ${truncate(snapshot.lastDreamSummary, 400)}`);
    }
    if (typeof snapshot.lastError === 'string' && snapshot.lastError !== '') {
      lines.push(`last error: ${snapshot.lastError}`);
    }
    const health = status.health;
    if (health && Array.isArray(health.warnings) && health.warnings.length > 0) {
      lines.push(`health: ${health.warnings.length} warning(s)`);
      for (const warning of health.warnings.slice(0, 6)) lines.push(`  - ${warning}`);
    }
    lines.push('');
    lines.push(
      'Commands: /memory json | list | show <file> | index | metrics | search <query> | history <file>',
    );
    lines.push('          /memory refresh | on | off | plugin on|off | rules [reset] | delete <file>');
    lines.push('          /memory backups | trash | restore <backup|trash> <id> [file]');
    lines.push('          /memory inbox list | show <id> | accept <id> | discard <id>');
    lines.push('          /memory dream on|off|status|run|switch|discard|undo');
    return ok(lines.join('\n'));
  }

  async function memoryJson(invocation) {
    const status = await collectStatus(invocation);
    const payload = status.ok ? payloadOf(status) : { ok: false, error: status.error };
    return ok(JSON.stringify(payload));
  }

  async function memoryList(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const { config, entries, snapshot } = status;
    const lines = [];
    lines.push(`MEMORY.md — ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);
    if (entries.length === 0) {
      lines.push('(no memory files yet)');
    } else {
      for (const entry of sortedEntries(entries)) {
        const description = entry.description ? ` — ${truncate(entry.description, 120)}` : '';
        const via = entry.via ? `  · via ${entry.via}` : '';
        lines.push(
          `- ${entry.file}  [${entry.type}] ${entry.name}${description}  (${formatBytes(entry.bytes)}${Number(entry.lines) > 0 ? `, ${entry.lines} lines` : ''})${via}`,
        );
      }
    }
    const index = status.index;
    lines.push('');
    lines.push(
      `index budget: ${Number(index?.lines) || 0}/${Number(config.indexMaxLines) || 0} lines, ${formatBytes(index?.bytes)}/${formatBytes(config.indexMaxBytes)}${index?.overflow ? ' — OVER BUDGET' : ''}`,
    );
    if (typeof snapshot.lastError === 'string' && snapshot.lastError !== '') {
      lines.push(`last error: ${snapshot.lastError}`);
    }
    return ok(lines.join('\n'));
  }

  async function memoryShow(invocation, args) {
    const { flags, positional } = splitFlags(args);
    const file = positional[0];
    if (typeof file !== 'string' || file === '') {
      return fail('usage: /memory show <file>');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    try {
      const entry = await service.file(status.pctx, file);
      const raw = typeof entry?.raw === 'string' ? entry.raw : '';
      // Effect metrics: a successful `/memory show` counts as one read.
      await recordRead(status.pctx.paths, entry?.file ?? file);
      return ok(raw === '' ? `(empty memory file: ${file})` : raw);
    } catch (error) {
      return fail(`memory show ${file}: ${errorText(error)}`);
    }
  }

  async function memoryIndex(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const text = typeof status.index?.text === 'string' ? status.index.text : '';
    return ok(text === '' ? '(MEMORY.md is empty)' : text);
  }

  /** `/memory metrics`: human-readable effect metrics + last dream cost. */
  async function memoryMetrics(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const metrics = status.metrics;
    if (!metrics || typeof metrics !== 'object') {
      return ok('no effect metrics yet (nothing has been injected, read or written)');
    }
    const inject = metrics.inject ?? {};
    const reads = metrics.reads ?? {};
    const writes = metrics.writes ?? {};
    const searches = metrics.searches ?? {};
    const dreams = metrics.dreams ?? {};
    const costs = metrics.costs ?? {};
    const lines = ['memory effect metrics'];
    lines.push(
      `since: ${formatTime(metrics.since)}${Number(metrics.since) > 0 ? ` (${formatAge(metrics.since)})` : ''}   updated: ${formatTime(metrics.updatedAt)}`,
    );
    lines.push(
      `injections: ${Number(inject.count) || 0}   last: ${Number(inject.lastAt) > 0 ? formatTime(inject.lastAt) : 'never'}`,
    );
    lines.push(
      `reads: ${Number(reads.total) || 0}   writes: ${Number(writes.total) || 0}   searches: ${Number(searches.count) || 0} (${Number(searches.hits) || 0} hits)`,
    );
    lines.push(`auto recalls: ${Number(metrics.recalls?.count) || 0} (${Number(metrics.recalls?.files) || 0} memories attached)`);
    const top = Array.isArray(reads.top) ? reads.top : [];
    lines.push(
      top.length > 0
        ? `top read: ${top.map((row) => `${row.file} (${row.reads})`).join(', ')}`
        : 'top read: (none yet)',
    );
    const neverRead = Array.isArray(reads.neverRead) ? reads.neverRead : [];
    lines.push(
      `never read: ${neverRead.length}${neverRead.length > 0 ? `  ${neverRead.slice(0, 5).join(', ')}${neverRead.length > 5 ? ' …' : ''}` : ''}`,
    );
    lines.push(
      `dreams: proposed ${Number(dreams.proposed) || 0}   applied ${Number(dreams.applied) || 0}   rejected ${Number(dreams.rejected) || 0}   failed ${Number(dreams.failed) || 0}   acceptance ${Math.round((Number(dreams.acceptanceRate) || 0) * 100)}%   applied ops ${Number(dreams.appliedOps) || 0}`,
    );
    const usage = costs.lastUsage && typeof costs.lastUsage === 'object' ? costs.lastUsage : null;
    const tokens = usage && Number.isFinite(Number(usage.totalTokens))
      ? ` · total tokens ${Number(usage.totalTokens)}`
      : '';
    lines.push(
      `last dream cost: ${formatDuration(costs.lastDurationMs)}${tokens} · in ${Number(costs.lastInputChars) || 0} chars · out ${Number(costs.lastOutputChars) || 0} chars`,
    );
    // v10: 7-day daily trend (text bars) and dream-plan quality.
    const trend = Array.isArray(metrics.trend) ? metrics.trend : [];
    if (trend.length > 0) {
      lines.push('7-day trend (injections/reads/writes/searches/adopted):');
      for (const day of trend) {
        lines.push(
          `  ${day.date}  ${bar(day.injections)} ${Number(day.injections) || 0} inject · ${Number(day.reads) || 0} read · ${Number(day.writes) || 0} write · ${Number(day.searches) || 0} search · ${Number(day.adopted) || 0} adopted`,
        );
      }
    }
    const quality = dreams.quality && typeof dreams.quality === 'object' ? dreams.quality : null;
    if (quality) {
      lines.push(
        `dream quality: applied ${Number(quality.appliedOps) || 0}/${Number(quality.planOps) || 0} planned ops (apply ${Math.round((Number(quality.applyRate) || 0) * 100)}%)   dropped ${Number(quality.dropped) || 0} (${Math.round((Number(quality.dropRate) || 0) * 100)}%)   rollbacks ${Number(quality.rollbacks) || 0}`,
      );
    }
    return ok(lines.join('\n'));
  }

  async function memoryToggle(invocation, key, value, label) {
    const result = await persistConfig({ [key]: value });
    if (!result.ok) return fail(`cc-memory: ${result.error}`);
    invalidate(invocation);
    return ok(
      `${label} set to ${value ? 'ON' : 'OFF'} in the plugin config. Reload the plugin for it to take effect.`,
    );
  }

  /**
   * `/memory plugin on|off`: the runtime override for the whole plugin, without
   * touching the profile config or restarting anything.
   */
  async function memoryPlugin(invocation, args) {
    const value = String(args?.[0] ?? '').toLowerCase();
    if (value !== 'on' && value !== 'off') return fail('usage: /memory plugin on|off');
    let toggled;
    try {
      toggled = await service.toggle(runtime, { enabled: value === 'on' });
    } catch (error) {
      return fail(`memory plugin ${value}: ${errorText(error)}`);
    }
    invalidate(invocation);
    const overrides = toggled?.overrides;
    return ok(
      `plugin ${value === 'on' ? 'enabled' : 'disabled'} at runtime (no reload needed); effective from the next request.` +
        (overrides && typeof overrides === 'object' ? `\noverrides: ${JSON.stringify(overrides)}` : ''),
    );
  }

  /**
   * `/memory rules`: show which rules file is injected and both candidate
   * paths. `/memory rules reset` deletes the project and global rule files so
   * the built-in defaults apply again.
   */
  async function memoryRules(invocation, args) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const rules = status.rules ?? {};
    const sub = String(args?.[0] ?? '').toLowerCase();
    if (sub === 'reset') {
      const layers = [
        { scope: 'project', file: rules.projectPath },
        { scope: 'global', file: rules.globalPath },
      ];
      let removed = 0;
      for (const layer of layers) {
        if (typeof layer.file !== 'string' || layer.file === '') continue;
        let existed = false;
        try {
          await fs.access(layer.file);
          existed = true;
        } catch {
          existed = false;
        }
        try {
          await service.saveRules(status.pctx, layer.scope, '', { source: 'command:/memory rules reset' });
          if (existed) removed += 1;
        } catch (error) {
          if (existed) warn(`rules reset ${layer.scope}`, error);
        }
      }
      try {
        runtime.invalidateAllInjections();
      } catch (error) {
        warn('invalidateAllInjections', error);
      }
      const fresh = await collectStatus(invocation);
      const source = fresh.ok ? fresh.rules?.source ?? 'default' : 'default';
      return ok(
        `rules reset: deleted ${removed} file(s); active source is now "${source}".`,
      );
    }
    if (sub !== '' && sub !== 'show' && sub !== 'status') {
      return fail('usage: /memory rules [reset]');
    }
    const lines = [];
    lines.push(`rules source: ${rules.source ?? 'unavailable'}`);
    lines.push(`project rules: ${rules.projectPath || '(unavailable)'}`);
    lines.push(`global rules:  ${rules.globalPath || '(unavailable)'}`);
    lines.push(
      `current: ${String(rules.text ?? '').length} chars${Number(rules.maxChars) > 0 ? ` (limit ${rules.maxChars})` : ''}`,
    );
    lines.push('');
    lines.push(String(rules.text ?? '') || '(built-in default rules)');
    lines.push('');
    lines.push('Edit the project or global file above; changes apply from the next request.');
    lines.push('Run /memory rules reset to delete both files and fall back to the defaults.');
    return ok(lines.join('\n'));
  }

  async function memoryDelete(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { flags, positional } = splitFlags(args);
    const file = positional[0];
    if (typeof file !== 'string' || file === '') {
      return fail('usage: /memory delete <file>');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    try {
      // Soft delete: the shared service moves the file into the project trash
      // instead of destroying it, so a mistaken `/memory delete` stays recoverable.
      const result = await service.deleteFile(status.pctx, file);
      invalidate(invocation);
      const target = typeof result.trashPath === 'string' && result.trashPath !== ''
        ? ` -> ${result.trashPath}`
        : '';
      return ok(`trashed memory file ${file}${target}`);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'delete-disabled') {
        return fail('memory delete is disabled; set dreamAllowDelete: true in the plugin config to enable it');
      }
      if (code === 'NOT_FOUND' || code === 'not-found') {
        return fail(`memory delete ${file}: file not found`);
      }
      return fail(`memory delete ${file}: ${errorText(error)}`);
    }
  }

  async function memoryDream(invocation, args) {
    const { flags, positional } = splitFlags(args);
    const sub = (positional[0] ?? 'status').toLowerCase();
    if (['run', 'switch', 'discard', 'undo'].includes(sub)) {
      const blocked = subagentGuard(invocation);
      if (blocked) return blocked;
    }
    if (sub === 'history') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let result;
      try {
        result = await service.dreamHistory(status.pctx);
      } catch (error) {
        return fail(`dream history: ${errorText(error)}`);
      }
      const items = Array.isArray(result?.items) ? result.items : [];
      if (items.length === 0) return ok('no dream batches yet');
      const lines = [`dream history — ${items.length} batch(es)`];
      for (const item of items) {
        const mark = item.undoable ? 'undoable' : item.undone ? 'undone' : 'kept';
        lines.push(`- ${item.ts}  ${formatTime(item.appliedAt)}  ${mark}   files: ${Number(item.ops) || 0}`);
        if (item.summary) lines.push(`  ${truncate(item.summary, 160)}`);
        if (Array.isArray(item.files) && item.files.length > 0) {
          lines.push(`  files: ${item.files.slice(0, 6).join(', ')}${item.files.length > 6 ? ' …' : ''}`);
        }
      }
      lines.push('');
      lines.push('Undo the latest applied batch: /memory dream undo');
      return ok(lines.join('\n'));
    }
    if (sub === 'undo') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action: 'undo' });
      } catch (error) {
        return fail(`dream undo: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream undo: ${response.message || response.error}`);
      invalidate(invocation);
      const result = response.result ?? {};
      if (result.ok === false || (typeof result.error === 'string' && result.error !== '')) {
        return fail(`dream undo: ${result.error ?? 'no-undoable-batch'}`);
      }
      const restored = Array.isArray(result.restored) ? result.restored : [];
      const trashed = Array.isArray(result.trashed) ? result.trashed : [];
      return ok(
        `undid dream batch ${result.batch ?? '(unknown)'}: restored ${restored.length} file(s), trashed ${trashed.length}`,
      );
    }
    if (sub === 'on' || sub === 'off') {
      return memoryToggle(invocation, 'autoDreamEnabled', sub === 'on', 'auto dream');
    }
    if (sub === 'estimate') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      try {
        const response = await service.dream(status.pctx, { action: 'estimate', focus: typeof flags.focus === 'string' ? flags.focus : '' });
        if (!response.ok) return fail(`dream estimate: ${response.message || response.error}`);
        const estimate = response.result;
        return ok(`Dream rough input estimate: ${estimate.estimatedTokens} tokens\nConfigured token limit: ${estimate.limit > 0 ? estimate.limit : 'unlimited'} (${estimate.costMode})\nActual total usage can be higher; this estimate is not a spending cap. No model was called and no memory was changed.`);
      } catch (error) { return fail(`dream estimate: ${errorText(error)}`); }
    }
    if (sub === 'status' && !positional[1] && typeof flags.run !== 'string') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      const { config, snapshot } = status;
      const sessions = Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince.length : 0;
      const counters = snapshot.counters && typeof snapshot.counters === 'object' ? snapshot.counters : {};
      const lines = [];
      lines.push('dream status');
      lines.push(
        `auto dream: ${config.autoDreamEnabled ? 'ON' : 'OFF'}   delete allowed: ${config.dreamAllowDelete ? 'yes' : 'no'}`,
      );
      lines.push(
        `gates: last dream >= ${config.minHours}h ago, >= ${config.minSessions} sessions since, scan throttle ${Math.round((Number(config.scanThrottleMs) || 0) / 60000)}m`,
      );
      lines.push(
        `cost cap: ${Number(config.dreamMaxTotalTokens) > 0 ? `${Number(config.dreamMaxTotalTokens)} total tokens (exceeding it warns but still applies)` : 'off (dreamMaxTotalTokens: 0)'}`,
      );
      lines.push(
        `last dream: ${formatTime(snapshot.lastDreamAt)}${Number(snapshot.lastDreamAt) > 0 ? ` (${formatAge(snapshot.lastDreamAt)})` : ''}`,
      );
      lines.push(`sessions since last dream: ${sessions}`);
      lines.push(`counters: ${JSON.stringify(counters)}`);
      if (typeof snapshot.lastDreamMode === 'string' && snapshot.lastDreamMode !== '') {
        lines.push(`last dream mode: ${snapshot.lastDreamMode}`);
      }
      if (typeof snapshot.lastDreamSummary === 'string' && snapshot.lastDreamSummary !== '') {
        lines.push(`last summary: ${truncate(snapshot.lastDreamSummary, 400)}`);
      }
      if (snapshot.shadowPending && typeof snapshot.shadowPending === 'object') {
        const waiting = Array.isArray(snapshot.shadowPending.files) ? snapshot.shadowPending.files.length : 0;
        lines.push(`pending dream result: ${waiting} file(s) (switch with /memory dream switch, discard with /memory dream discard)`);
      } else {
        lines.push('pending dream result: none');
      }
      if (typeof snapshot.lastError === 'string' && snapshot.lastError !== '') {
        lines.push(`last error: ${snapshot.lastError}`);
      }
      const runs = Array.isArray(status.payload?.dreamRuns) ? status.payload.dreamRuns : [];
      if (runs.length > 0) {
        const latest = runs[0];
        lines.push('');
        lines.push(`latest run: ${latest.runId} — ${latest.status}${latest.stage ? ` at ${latest.stage}` : ''}`);
        lines.push(
          `  units: ${latest.counts?.done ?? 0}/${latest.input?.expectedUnits ?? 0} done, ${latest.counts?.failed ?? 0} failed, ${latest.counts?.pending ?? 0} pending`,
        );
        if (latest.error) lines.push(`  error: ${truncate(latest.error, 240)}`);
      }
      lines.push('');
      lines.push('Run /memory dream run [--focus <text>] to consolidate now; a finished run waits until you switch to it or discard it.');
      lines.push('Long runs can be checked with /memory dream status <runId>, stopped with /memory dream cancel, and continued with /memory dream resume <runId>.');
      return ok(lines.join('\n'));
    }
    if (sub === 'run') {
      // `--wait` blocks until the run finishes; otherwise it runs in the background.
      const wait = flags.wait === true;
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, {
          agent: invocation.agent,
          sessionId: invocation?.agent?.id,
          action: wait ? 'run' : 'start',
          trigger: 'manual',
          focus: typeof flags.focus === 'string' ? flags.focus : '',
        });
      } catch (error) {
        return fail(`dream run: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream run: ${response.message || response.error}`);
      invalidate(invocation);
      if (wait) return ok(formatDreamRun(response.result));
      const started = response.result ?? {};
      if (started.started !== true && started.reused !== true) {
        return fail(`dream run: ${started.message || started.error || 'could not start'}`);
      }
      const runId = String(started.runId ?? '');
      return ok(
        [
          `dream run ${started.reused === true ? 'already running' : 'started'}: ${runId}`,
          `progress:  /memory dream status ${runId}`,
          `stop:      /memory dream cancel ${runId}`,
          `continue:  /memory dream resume ${runId}`,
          'the run continues in the background; each finished unit is saved, so stopping loses no completed work.',
        ].join('\n'),
      );
    }
    if (sub === 'cancel' || sub === 'resume' || sub === 'status') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      const runId = positional[1] ?? (typeof flags.run === 'string' ? flags.run : '');
      const action = sub === 'cancel' ? 'cancel' : sub === 'resume' ? 'resume' : 'status';
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action, runId });
      } catch (error) {
        return fail(`dream ${action}: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream ${action}: ${response.message || response.error}`);
      if (action === 'cancel') {
        const result = response.result ?? {};
        return result.cancelled === true
          ? ok(`dream run ${result.runId} is stopping; finished units stay saved, so it can be resumed.`)
          : fail(`no running dream run${runId ? ` ${runId}` : ''} to cancel`);
      }
      if (action === 'resume') {
        const result = response.result ?? {};
        if (result.started !== true) return fail(`dream resume: ${result.message || result.error || 'could not resume'}`);
        invalidate(invocation);
        return ok([
          `dream run ${result.runId} resumed${result.reused === true ? ' (was already running)' : ''}`,
          `progress:  /memory dream status ${result.runId}`,
        ].join('\n'));
      }
      return ok(formatDreamRunStatus(response.result));
    }
    if (sub === 'switch') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action: 'switch' });
      } catch (error) {
        return fail(`dream switch: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream switch: ${response.message || response.error}`);
      invalidate(invocation);
      return ok(formatDreamSwitch(response.result));
    }
    if (sub === 'discard') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action: 'discard' });
      } catch (error) {
        return fail(`dream discard: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream discard: ${response.message || response.error}`);
      const result = response.result ?? {};
      if (result.discarded === true) return ok('discarded the dream result; memory is unchanged');
      return fail(`dream discard: ${result.reason || result.error || 'nothing to discard'}`);
    }

  }

  // -- /memory backups | trash | restore -------------------------------------

  async function memoryBackups(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.backups(status.pctx);
    } catch (error) {
      return fail(`backups: ${errorText(error)}`);
    }
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) {
      return ok('no dream backups yet (each dream apply creates .dreams/<timestamp>/)');
    }
    const lines = [`dream backups — ${items.length}`];
    for (const item of items) {
      lines.push(`- ${item.id}  ${formatTime(item.at)}  (${item.files.length} file(s))`);
      if (item.files.length > 0) {
        const shown = item.files.slice(0, 6).join(', ');
        const more = item.files.length > 6 ? ` … +${item.files.length - 6}` : '';
        lines.push(`  ${shown}${more}`);
      }
    }
    lines.push('');
    lines.push('Restore one: /memory restore backup <id> [file]');
    return ok(lines.join('\n'));
  }

  async function memoryTrash(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.trash(status.pctx);
    } catch (error) {
      return fail(`trash: ${errorText(error)}`);
    }
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) return ok('the memory trash is empty');
    const lines = [`memory trash — ${items.length} batch(es)`];
    for (const item of items) {
      lines.push(`- ${item.id}  ${formatTime(item.at)}  (${item.files.length} file(s))`);
      if (item.files.length > 0) {
        const shown = item.files.slice(0, 6).join(', ');
        const more = item.files.length > 6 ? ` … +${item.files.length - 6}` : '';
        lines.push(`  ${shown}${more}`);
      }
    }
    lines.push('');
    lines.push('Restore one: /memory restore trash <id> [file]');
    return ok(lines.join('\n'));
  }

  async function memoryRestore(invocation, args) {
    const { positional } = splitFlags(args);
    const kind = String(positional[0] ?? '').toLowerCase();
    const id = positional[1];
    const file = positional[2];
    if ((kind !== 'backup' && kind !== 'trash') || typeof id !== 'string' || id === '') {
      return fail('usage: /memory restore <backup|trash> <id> [file]');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.restore(status.pctx, { kind, id, file });
    } catch (error) {
      return fail(`restore ${kind} ${id}: ${errorText(error)}`);
    }
    invalidate(invocation);
    const restored = Array.isArray(result?.restored) ? result.restored : [];
    const lines = [`restored ${restored.length} file(s) from ${kind} ${id}: ${restored.join(', ')}`];
    const gained = Array.isArray(result?.reconciled?.missing) ? result.reconciled.missing : [];
    const removed = Array.isArray(result?.reconciled?.dangling) ? result.reconciled.dangling : [];
    if (gained.length > 0) lines.push(`index gained: ${gained.join(', ')}`);
    if (removed.length > 0) lines.push(`index dropped dangling entries: ${removed.join(', ')}`);
    return ok(lines.join('\n'));
  }

  // -- session controls -------------------------------------------------------

  /** `/memory refresh`: rebuild this session's injected memory text immediately. */
  async function memoryRefresh(invocation) {
    const sessionId = invocation?.agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return fail('memory refresh: no live session id');
    try {
      runtime.refreshSession(sessionId);
      await runtime.drain();
      const text = String(runtime.getInjectedText?.(sessionId) ?? '');
      const lines = [`injection refreshed — ${text.length} chars`];
      if (text !== '') lines.push('', truncate(text, 800));
      return ok(lines.join('\n'));
    } catch (error) {
      return fail(`memory refresh: ${errorText(error)}`);
    }
  }

  // -- v10: search / edit / merge / history / import / export ----------------

  /** `/memory search <query>`: ranked search with snippets. */
  async function memorySearch(invocation, args) {
    const { flags, positional } = splitFlags(args);
    const query = positional.join(' ').trim() || (typeof flags.q === 'string' ? flags.q.trim() : '');
    if (query === '') {
      return fail('usage: /memory search <query> [--type=user|feedback|project|reference] [--limit=10]');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.search(status.pctx, {
        query,
        type: flags.type,
        limit: Number(flags.limit) || 10,
      });
    } catch (error) {
      return fail(`memory search: ${errorText(error)}`);
    }
    const lines = [`search "${query}" — ${result.total} match(es)`];
    for (const hit of result.items) {
      lines.push(`- ${hit.file}  [${hit.type}] ${hit.name}  (score ${hit.score})`);
      if (hit.description) lines.push(`  ${truncate(hit.description, 120)}`);
      for (const snippet of (Array.isArray(hit.snippets) ? hit.snippets : []).slice(0, 2)) {
        lines.push(`  » ${truncate(snippet, 140)}`);
      }
    }
    if (result.items.length === 0) lines.push('(no matches)');
    return ok(lines.join('\n'));
  }

  /** `/memory edit <file> [--name/--type/--description/--content]`: update one file. */
  async function memoryEdit(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { flags, positional } = splitFlags(args);
    const file = positional[0];
    if (typeof file !== 'string' || file === '') {
      return fail('usage: /memory edit <file> [--name=..] [--type=..] [--description=..] [--content=..]');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const input = { file };
    for (const key of ['name', 'type', 'description', 'content']) {
      if (typeof flags[key] === 'string') input[key] = flags[key];
    }
    let result;
    try {
      result = await service.writeFile(status.pctx, input);
    } catch (error) {
      return fail(`memory edit ${file}: ${errorText(error)}`);
    }
    invalidate(invocation);
    return ok(`saved memory file ${result.file}${result.created ? ' (created)' : ''}`);
  }

  /** `/memory merge <file1> <file2> [...]`: merge files into one. */
  async function memoryMerge(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { flags, positional } = splitFlags(args);
    if (positional.length < 2) {
      return fail(
        'usage: /memory merge <file1> <file2> [...] [--name=..] [--type=user|feedback|project|reference] [--description=..]',
      );
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.mergeFiles(status.pctx, {
        files: positional,
        name: flags.name,
        type: flags.type,
        description: flags.description,
      });
    } catch (error) {
      return fail(`memory merge: ${errorText(error)}`);
    }
    invalidate(invocation);
    const lines = [`merged ${positional.length} file(s) into ${result.file}`];
    if (Array.isArray(result.trashed) && result.trashed.length > 0) {
      lines.push(`trashed: ${result.trashed.join(', ')}`);
    }
    const gained = Array.isArray(result.reconciled?.missing) ? result.reconciled.missing : [];
    if (gained.length > 0) lines.push(`index gained: ${gained.join(', ')}`);
    return ok(lines.join('\n'));
  }

  /** `/memory history <file>`: provenance + changelog + plan references. */
  async function memoryHistory(invocation, args) {
    const { positional } = splitFlags(args);
    const file = positional[0];
    if (typeof file !== 'string' || file === '') return fail('usage: /memory history <file>');
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.fileHistory(status.pctx, file);
    } catch (error) {
      return fail(`memory history ${file}: ${errorText(error)}`);
    }
    const lines = [`history — ${result.file}`];
    const provenance = result.provenance ?? {};
    lines.push(
      `provenance: created ${provenance.created || '-'}   session ${provenance.sourceSession || '-'}   via ${provenance.via || '-'}`,
    );
    const changelog = Array.isArray(result.changelog) ? result.changelog : [];
    lines.push(`changelog: ${changelog.length} line(s)`);
    for (const line of changelog.slice(-10)) lines.push(`  ${truncate(line, 160)}`);
    const refs = Array.isArray(result.planRefs) ? result.planRefs : [];
    lines.push(`plan references: ${refs.length}`);
    for (const ref of refs.slice(0, 10)) {
      if (ref.type === 'dream') {
        lines.push(`  dream ${ref.ts} (${ref.kind || 'unknown'}, ops ${ref.ops})`);
      } else {
        lines.push(`  pending ${ref.id}`);
      }
    }
    return ok(lines.join('\n'));
  }

  /** `/memory import <path>`: import a Claude Code memory directory. */
  async function memoryImport(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { positional } = splitFlags(args);
    // Read the path from the raw input: the tokenizer treats `\` as an escape,
    // which would mangle Windows paths like C:\Users\...
    const sourcePath = rawArgumentAfter(invocation?.rawInput, 'import') || positional[0];
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      return fail('usage: /memory import <path-to-claude-memory-dir>');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.importMemory(status.pctx, { sourceDir: sourcePath });
    } catch (error) {
      return fail(`memory import: ${errorText(error)}`);
    }
    invalidate(invocation);
    const lines = [
      `imported ${result.imported.length} file(s) from ${result.sourceDir}`,
      `skipped: ${result.skipped.length}   errors: ${result.errors.length}`,
    ];
    if (result.skipped.length > 0) {
      lines.push(`skipped files: ${result.skipped.slice(0, 5).map((item) => item.file ?? item).join(', ')}`);
    }
    return ok(lines.join('\n'));
  }

  /** `/memory export <path>`: export into a Claude Code memory layout. */
  async function memoryExport(invocation, args) {
    const { positional } = splitFlags(args);
    const targetPath = rawArgumentAfter(invocation?.rawInput, 'export') || positional[0];
    if (typeof targetPath !== 'string' || targetPath === '') {
      return fail('usage: /memory export <target-dir>');
    }
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    let result;
    try {
      result = await service.exportMemory(status.pctx, { targetDir: targetPath });
    } catch (error) {
      return fail(`memory export: ${errorText(error)}`);
    }
    return ok(
      `exported ${result.exported.length} file(s) to ${result.targetDir}${result.rules ? ' (rules included)' : ''}`,
    );
  }

  // -- /remember -------------------------------------------------------------

  async function remember(invocation) {
    const parsed = parseRememberInput(invocation?.rawInput);
    if (parsed.text === '') return fail(`usage: /remember ${REMEMBER_HINT}`);
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const type = TYPE_SET.has(parsed.type) ? parsed.type : '';
    if (type === '') {
      return fail(`unknown memory type "${parsed.type}"; use one of ${MEMORY_TYPES.join(', ')}`);
    }
    let pctx;
    try {
      pctx = await requireProject(invocation);
    } catch (error) {
      return fail(`remember: ${errorText(error)}`);
    }
    const config = runtime.config;
    const name = deriveName(parsed.text);
    const description = firstLine(parsed.text);
    try {
      const saved = await pctx.store.saveEntry({
        name,
        type,
        description,
        // The human typed this themselves, so it is the current value without a
        // model-authored status line or an evidence gate.
        content: ensureCurrentStatus(parsed.text),
        source: { sessionId: invocation?.agent?.id, via: 'command:/remember' },
      });
      invalidate(invocation);
      const verification = typeof saved?.file === 'string' && saved.file !== ''
        // The user typed this note themselves, so the saved bytes are the
        // confirmed value: count the write and mark it verified, which keeps the
        // note's summary in the next session's first-turn index.
        ? await recordUserConfirmedSave({
          store: pctx.store,
          paths: pctx.paths,
          file: saved.file,
          entry: saved,
        })
        : 'pending';
      const lines = [`saved memory: ${typeof saved?.file === 'string' ? saved.file : name}`];
      lines.push(`type: ${typeof saved?.type === 'string' ? saved.type : type}   name: ${typeof saved?.name === 'string' ? saved.name : name}`);
      if (typeof saved?.version === 'string' && saved.version !== '') lines.push(`version: ${saved.version}`);
      lines.push(
        verification === 'recorded'
          ? 'verification: current (first-turn summary available)'
          : 'verification: pending (saved; first-turn index will show the name only until the next write)',
      );
      if (saved?.index?.warning) lines.push(`warning: ${saved.index.warning}`);
      if (Array.isArray(saved?.warnings)) {
        for (const warning of saved.warnings) lines.push(`warning: ${warning}`);
      }
      lines.push(
        `index: ${Number(saved?.index?.lines) || 0}/${Number(config.indexMaxLines) || 0} lines, ${formatBytes(saved?.index?.bytes)}/${formatBytes(config.indexMaxBytes)}`,
      );
      return ok(lines.join('\n'));
    } catch (error) {
      return fail(`remember: ${errorText(error)}`);
    }
  }

  /**
   * `/memory inbox` — review proposals staged by the optional auto-extractor.
   * Accepting replays the proposal through the regular `memory_save` gates so
   * evidence, duplicate checks, secret scanning and index budgets still apply.
   */
  async function memoryInbox(invocation, args) {
    const pctx = await requireProject(invocation);
    const action = (args[0] ?? 'list').toLowerCase();
    if (action === 'list' || action === '') {
      const records = await listProposals(pctx.paths);
      if (records.length === 0) return ok('inbox: empty');
      const lines = [`inbox: ${records.length} pending`];
      for (const record of records) {
        lines.push(`- ${record.id}  ${record.createdAt}  ${record.sessionId}`);
        for (const item of record.items) lines.push(`  [${item.type}] ${item.name} — ${item.description ?? ''}`);
      }
      lines.push('usage: /memory inbox accept <id> | show <id> | discard <id>');
      return ok(lines.join('\n'));
    }
    const id = args[1];
    if (action === 'show') {
      if (!id) return fail('usage: /memory inbox show <id>');
      const record = await readProposal(pctx.paths, id);
      return ok(JSON.stringify(record, null, 2));
    }
    if (action === 'discard') {
      if (!id) return fail('usage: /memory inbox discard <id>');
      await removeProposal(pctx.paths, id);
      return ok(`inbox: discarded ${id}`);
    }
    if (action === 'accept') {
      if (!id) return fail('usage: /memory inbox accept <id>');
      const record = await readProposal(pctx.paths, id);
      const results = await applyProposals({
        runtime,
        items: record.items,
        sessionId: record.sessionId,
        agent: invocation.agent ?? { id: record.sessionId },
      });
      const written = results.filter((item) => item.ok).length;
      const failed = results.filter((item) => !item.ok);
      if (failed.length === 0) await removeProposal(pctx.paths, id);
      const lines = [`inbox: accepted ${written}/${results.length} from ${id}`];
      for (const item of failed) lines.push(`- failed ${item.name}: ${item.message ?? item.error ?? 'unknown'}`);
      return failed.length === 0 ? ok(lines.join('\n')) : fail(lines.join('\n'));
    }
    return fail(`unknown inbox action "${action}". usage: /memory inbox list|show <id>|accept <id>|discard <id>`);
  }

  // -- dispatch --------------------------------------------------------------

  async function handleMemory(invocation) {
    try {
      const { verb, args } = parseCommandLine(invocation?.rawInput);
      switch (verb) {
        case '':
        case 'status':
          return await memoryStatus(invocation);
        case 'help':
          return ok(
            [
              `usage: /memory ${MEMORY_HINT}`,
              '       /dream run [--focus <text>]|status|switch|discard|history|undo   (short alias for /memory dream …)',
              '       /memory dream on|off|status|history|undo|run|switch|discard',
              '       /memory backups | trash | restore <backup|trash> <id> [file]',
              '       /memory metrics   (injections, reads, writes, searches, dream acceptance, 7-day trend, quality, last cost)',
              '       /memory search <query> | show <file> | history <file> | edit <file> | merge <file1> <file2> [...]',
              '       /memory import <path> | export <path>   (Claude Code memory interoperability)',
              '       /memory inbox list | show <id> | accept <id> | discard <id>   (review auto-extracted proposals)',
              '       /memory refresh',
              '       /memory rules [reset]',
              `       /remember ${REMEMBER_HINT}`,
              '       /memory on|off toggles autoMemoryEnabled; /memory plugin on|off toggles the plugin at runtime (override, no reload).',
            ].join('\n'),
          );
        case 'json':
          return await memoryJson(invocation);
        case 'list':
          return await memoryList(invocation);
        case 'show':
          return await memoryShow(invocation, args);
        case 'index':
          return await memoryIndex(invocation);
        case 'metrics':
          return await memoryMetrics(invocation);
        case 'search':
          return await memorySearch(invocation, args);
        case 'edit':
          return await memoryEdit(invocation, args);
        case 'merge':
          return await memoryMerge(invocation, args);
        case 'history':
          return await memoryHistory(invocation, args);
        case 'import':
          return await memoryImport(invocation, args);
        case 'export':
          return await memoryExport(invocation, args);
        case 'refresh':
          return await memoryRefresh(invocation);
        case 'backups':
          return await memoryBackups(invocation);
        case 'trash':
          return await memoryTrash(invocation);
        case 'restore':
          return await memoryRestore(invocation, args);
        case 'inbox':
          return await memoryInbox(invocation, args);
        case 'on':
          return await memoryToggle(invocation, 'autoMemoryEnabled', true, 'auto memory');
        case 'off':
          return await memoryToggle(invocation, 'autoMemoryEnabled', false, 'auto memory');
        case 'delete':
          return await memoryDelete(invocation, args);
        case 'plugin':
          return await memoryPlugin(invocation, args);
        case 'rules':
          return await memoryRules(invocation, args);
        case 'dream':
          return await memoryDream(invocation, args);
        default:
          return fail(`unknown /memory subcommand "${verb}".\nusage: /memory ${MEMORY_HINT}`);
      }
    } catch (error) {
      return fail(`cc-memory: ${errorText(error)}`);
    }
  }

  async function handleRemember(invocation) {
    try {
      return await remember(invocation);
    } catch (error) {
      return fail(`remember: ${errorText(error)}`);
    }
  }

  /** Register one definition, keeping the disposer for plugin unload. */
  function register(definition) {
    try {
      if (!commandsService || typeof commandsService.register !== 'function') {
        warn('commands', new Error('the commands service is unavailable; slash commands are not registered'));
        return;
      }
      const dispose = commandsService.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(`register /${definition.name}`, error);
    }
  }

  register({
    name: MEMORY_NAME,
    description: 'Inspect auto memory and dreaming: index, topic files, gates and manual consolidation.',
    input: { hint: MEMORY_HINT },
    handler: handleMemory,
  });
  register({
    name: REMEMBER_NAME,
    description: 'Save one durable memory note for this project (/remember [--type=..] text).',
    input: { hint: REMEMBER_HINT },
    handler: handleRemember,
  });
  register({
    name: 'dream',
    // Short human entry point for the same feature the Memory page calls Dream.
    description: 'Dream: consolidate memory now (/dream status [runId] | run [--wait] | cancel [runId] | resume [runId] | switch | discard | history | undo).',
    input: { hint: 'run|status|switch|discard|history|undo' },
    handler: (invocation) =>
      handleMemory({ ...invocation, rawInput: `dream ${String(invocation?.rawInput ?? '')}`.trimEnd() }),
  });

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        warn('dispose command', error);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Dream result rendering
// ---------------------------------------------------------------------------

/** Render one resumable-run summary as chat text. */
function formatDreamRunStatus(run) {
  if (!run || typeof run !== 'object') return 'no dream run recorded';
  if (run.ok === false) return `dream status: ${run.error ?? 'unavailable'}${run.message ? ` — ${run.message}` : ''}`;
  if (run.status === 'none') return 'no dream runs recorded yet; start one with /memory dream run';
  const lines = [];
  lines.push(`dream run ${run.runId || '(unknown)'} — ${run.status || 'unknown'}${run.stage ? ` at ${run.stage}` : ''}`);
  const counts = run.counts && typeof run.counts === 'object' ? run.counts : {};
  const expected = Number(run.input?.expectedUnits) || 0;
  lines.push(`units: ${Number(counts.done) || 0}/${expected} done, ${Number(counts.failed) || 0} failed, ${Number(counts.pending) || 0} pending`);
  if (run.coverageComplete === true) lines.push('coverage: complete');
  if (run.coverageComplete === false) lines.push('coverage: incomplete — apply stays blocked until every unit finishes');
  if (run.planPath) lines.push(`plan: ${run.planPath}${run.status === 'review' ? ' (apply with /memory dream apply)' : ''}`);
  if (run.blockedReason) lines.push(`blocked: ${truncate(run.blockedReason, 300)}`);
  if (run.error) lines.push(`error: ${truncate(run.error, 300)}`);
  if (run.skipReason) lines.push(`skipped: ${run.skipReason}`);
  const sessions = Array.isArray(run.sessions) ? run.sessions : [];
  for (const session of sessions.slice(0, 5)) {
    lines.push(`- ${session.id}: ${session.done}/${session.units} unit(s)${session.failed ? `, ${session.failed} failed` : ''}`);
  }
  const pending = Array.isArray(run.pendingUnits) ? run.pendingUnits : [];
  if (pending.length > 0) {
    lines.push(`pending units: ${pending.slice(0, 5).map((unit) => `${unit.sessionId}#${unit.firstSeq ?? '?'}-${unit.lastSeq ?? '?'}`).join(', ')}${pending.length > 5 ? ' …' : ''}`);
  }
  const errors = Array.isArray(run.errors) ? run.errors : [];
  for (const item of errors.slice(0, 3)) {
    lines.push(`failed unit ${item.sessionId ?? '?'}/${item.unitId ?? '?'}: ${truncate(String(item.error ?? ''), 200)}`);
  }
  if (run.status === 'running') {
    lines.push(`stop: /memory dream cancel ${run.runId}`);
  } else if (['failed', 'cancelled', 'blocked', 'ready'].includes(run.status)) {
    lines.push(`continue: /memory dream resume ${run.runId}`);
  }
  return lines.join('\n');
}

/** Render one `DreamRunResult` as chat text. */
function formatDreamRun(result) {
  if (!result || typeof result !== 'object') return 'dream run: the engine returned no result';
  const lines = [];
  lines.push('dream run');
  if (Number.isFinite(result.estimatedTokens)) lines.push(`rough input estimate: ${result.estimatedTokens} tokens (actual total can be higher)`);
  if (result.ran === false) {
    lines.push(`skipped: ${result.skipReason ?? 'unknown reason'}`);
    if (result.error) lines.push(`error: ${errorText(result.error)}`);
    return lines.join('\n');
  }
  lines.push(`sessions reviewed: ${Number(result.sessionsReviewed) || 0}`);
  if (result.summary) lines.push(`summary: ${String(result.summary)}`);
  const counts = result.counts && typeof result.counts === 'object' ? result.counts : null;
  if (counts) {
    lines.push(`result: +${Number(counts.added) || 0} added, ~${Number(counts.changed) || 0} changed, -${Number(counts.removed) || 0} removed`);
  }
  const files = Array.isArray(result.files) ? result.files : [];
  for (const item of files.slice(0, 40)) {
    const file = item && typeof item === 'object' ? item : {};
    lines.push(`  - ${String(file.action ?? 'changed')} ${file.file ?? ''}`);
  }
  if (files.length > 40) lines.push(`  … ${files.length - 40} more`);
  if (result.shadowDir) lines.push(`result kept in: ${result.shadowDir} (switch with /memory dream switch, discard with /memory dream discard)`);
  if (result.error) lines.push(`error: ${errorText(result.error)}`);
  if (Array.isArray(result.warnings)) for (const warning of result.warnings) lines.push(`warning: ${truncate(warning, 500)}`);
  return lines.join('\n');
}

/** Render one `switchShadow` result as chat text. */
function formatDreamSwitch(result) {
  if (!result || typeof result !== 'object') return 'dream switch: the engine returned no result';
  const lines = [];
  if (result.switched !== true) {
    lines.push(`dream switch: not switched (${errorText(result.error || result.reason || 'unknown')})`);
    if (Array.isArray(result.conflicts) && result.conflicts.length > 0) {
      lines.push('memory changed while the dream ran, so nothing was replaced:');
      for (const item of result.conflicts.slice(0, 10)) {
        lines.push(`  - ${item.file}: ${item.reason}`);
      }
      lines.push('Run /memory dream run again to rebuild the result from the current notes.');
    }
    return lines.join('\n');
  }
  const counts = result.counts && typeof result.counts === 'object' ? result.counts : {};
  lines.push('memory switched to the dream result');
  lines.push(`added: ${Number(counts.added) || 0}   changed: ${Number(counts.changed) || 0}   removed: ${Number(counts.removed) || 0}`);
  if (result.backupDir) lines.push(`backup: ${result.backupDir}`);
  lines.push('undo with /memory dream undo');
  return lines.join('\n');
}
