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
import { recordRead, recordWrite } from './metrics.js';
import { createStatusService, subagentWriteBlocked } from './status.js';

/** Root command names, also accepted by `parseCommandLine` with a leading slash. */
const MEMORY_NAME = 'memory';
const REMEMBER_NAME = 'remember';

/** Supported frontmatter types for a hand-written memory note. */
const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);

/** Fast membership check for the supported frontmatter types. */
const TYPE_SET = new Set(MEMORY_TYPES);

const MEMORY_HINT =
  '[json|status|list|index|metrics|search <query>|show <file>|history <file>|edit <file> [--name/--type/--description/--content]|merge <file1> <file2> [...]|writes|approve <id>|reject <id>|refresh|live on|off|user on|off|import <path>|export <path>|on|off|plugin on|off|delete <file>|rules [reset]|backups|trash|restore <backup|trash> <id> [file]|dream on|off|dream status|dream history|dream undo|dream run [--dry-run] [--focus <text>]|dream apply|dream reject|dream preview|dream apply-ops <indexes>]';
const REMEMBER_HINT = '[--type=user|feedback|project|reference] [--scope=project|user] <text>';

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
 * `--type=`/`--scope=` flags followed by the free-form text.
 *
 * The text is sliced from the original string so internal whitespace,
 * punctuation and newlines survive untouched.
 *
 * @param {unknown} rawInput
 * @returns {{type: string, scope: string, text: string}}
 */
export function parseRememberInput(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const tokens = tokenize(raw);
  let type = 'user';
  let scope = 'project';
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].value;
    const match = /^--(type|scope)(?:=(.*))?$/iu.exec(token);
    if (match === null) break;
    const key = match[1].toLowerCase();
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = tokens[index]?.value ?? '';
      index += 1;
    } else {
      index += 1;
    }
    if (key === 'type') type = value.toLowerCase();
    else scope = value.toLowerCase();
  }
  const text = raw.slice(tokens[index]?.start ?? raw.length).trim();
  return { type, scope, text };
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
 * @param {{config: object, forAgent: Function, dream: Function, applyPendingDream: Function, applyLastPlan?: Function,
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
  const commandsService = (() => {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const service = ctx.get('commands');
        if (service) return service;
      }
    } catch {
      /* fall through to the property access */
    }
    return ctx?.commands;
  })();

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
    if (!runtime || typeof runtime.forAgent !== 'function') {
      throw new Error('memory runtime is unavailable in this profile');
    }
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
        runtime?.config && typeof runtime.config === 'object' ? runtime.config : payload.config ?? {};
      return {
        ok: true,
        pctx,
        payload,
        config,
        overrides: payload.overrides ?? {},
        rules: payload.rules,
        index: payload.index,
        entries: Array.isArray(payload.entries) ? payload.entries : [],
        userEntries: Array.isArray(payload.userScope?.entries) ? payload.userScope.entries : [],
        snapshot: payload.state && typeof payload.state === 'object' ? payload.state : {},
        changelogTail: typeof payload.changelogTail === 'string' ? payload.changelogTail : '',
        trashCount: Number(payload.trashCount) || 0,
        metrics: payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : null,
        pendingWrites:
          payload.pendingWrites && typeof payload.pendingWrites === 'object'
            ? payload.pendingWrites
            : { count: 0, items: [] },
        readiness: payload.readiness ?? null,
        healthScore: Number.isFinite(Number(payload.healthScore)) ? Number(payload.healthScore) : null,
        session: payload.session && typeof payload.session === 'object' ? payload.session : { live: false, mode: 'auto' },
        subagentPolicy:
          payload.subagentPolicy && typeof payload.subagentPolicy === 'object'
            ? payload.subagentPolicy
            : {
                injectSubagents: config.injectSubagents !== false,
                mode: config.subagentWriteMode === 'off' ? 'off' : 'shared',
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
      userEntries,
      snapshot,
      changelogTail,
      trashCount,
      metrics,
      pendingWrites,
      readiness,
      healthScore,
      session,
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
        dreamMode: config.dreamMode === 'review' ? 'review' : 'apply',
        minHours: Number(config.minHours) || 0,
        minSessions: Number(config.minSessions) || 0,
        indexMaxLines: Number(config.indexMaxLines) || 0,
        indexMaxBytes: Number(config.indexMaxBytes) || 0,
        dreamAllowDelete: Boolean(config.dreamAllowDelete),
        userMemoryEnabled: Boolean(config.userMemoryEnabled),
        dreamMaxTotalTokens: Number(config.dreamMaxTotalTokens) || 0,
        writeMode: config.writeMode === 'confirm' ? 'confirm' : 'auto',
        policyDuplicateThreshold: Number(config.policyDuplicateThreshold) || 0.82,
        policySuggestThreshold: Number(config.policySuggestThreshold) || 0.55,
        pendingProposalTtlHours: Number(config.pendingProposalTtlHours) || 72,
        dreamCostMode: config.dreamCostMode === 'review' || config.dreamCostMode === 'block' ? config.dreamCostMode : 'warn',
        projectId: typeof config.projectId === 'string' ? config.projectId : '',
        userIndexMaxLines: Number(config.userIndexMaxLines) || 30,
        userIndexMaxBytes: Number(config.userIndexMaxBytes) || 4096,
        compactionDigest: config.compactionDigest !== false,
        subagentWriteMode: config.subagentWriteMode === 'off' ? 'off' : 'shared',
      },
      index: {
        text: typeof index?.text === 'string' ? index.text : '',
        lines: Number(index?.lines) || 0,
        bytes: Number(index?.bytes) || 0,
        truncated: Boolean(index?.truncated),
        overflow: Boolean(index?.overflow),
      },
      entries: entries.map(normalizeEntry),
      userScope: {
        enabled: Boolean(config.userMemoryEnabled),
        entries: userEntries.map(normalizeEntry),
        budgets: {
          maxLines: Number(config.userIndexMaxLines) || 0,
          maxBytes: Number(config.userIndexMaxBytes) || 0,
        },
      },
      state: {
        lastDreamAt: Number(snapshot.lastDreamAt) || 0,
        lastDreamAttemptAt: Number(snapshot.lastDreamAttemptAt) || 0,
        lastError: typeof snapshot.lastError === 'string' ? snapshot.lastError : '',
        lastDreamSummary: typeof snapshot.lastDreamSummary === 'string' ? snapshot.lastDreamSummary : '',
        lastDreamSessions: Number(snapshot.lastDreamSessions) || 0,
        lastDreamOps: Number(snapshot.lastDreamOps) || 0,
        lastDreamMode: typeof snapshot.lastDreamMode === 'string' ? snapshot.lastDreamMode : '',
        lastPlanPath: typeof snapshot.lastPlanPath === 'string' ? snapshot.lastPlanPath : '',
        pendingProposal: typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '',
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
      pendingWrites:
        pendingWrites && typeof pendingWrites === 'object'
          ? {
              count: Number(pendingWrites.count) || 0,
              items: (Array.isArray(pendingWrites.items) ? pendingWrites.items : []).map((item) => ({
                id: typeof item?.id === 'string' ? item.id : '',
                createdAt: Number(item?.createdAt) || 0,
                reasons: Array.isArray(item?.reasons) ? item.reasons : [],
                candidate: {
                  name: typeof item?.candidate?.name === 'string' ? item.candidate.name : '',
                  type: typeof item?.candidate?.type === 'string' ? item.candidate.type : '',
                  description: typeof item?.candidate?.description === 'string' ? item.candidate.description : '',
                },
              })),
            }
          : { count: 0, items: [] },
      readiness: readiness && typeof readiness === 'object' ? readiness : null,
      healthScore: Number.isFinite(Number(healthScore)) ? Number(healthScore) : null,
      session: session && typeof session === 'object' ? { live: session.live === true, mode: session.mode ?? 'auto' } : { live: false, mode: 'auto' },
      subagentPolicy:
        subagentPolicy && typeof subagentPolicy === 'object'
          ? {
              injectSubagents: subagentPolicy.injectSubagents !== false,
              mode: subagentPolicy.mode === 'off' ? 'off' : 'shared',
            }
          : { injectSubagents: true, mode: 'shared' },
      changelogTail: typeof changelogTail === 'string' ? changelogTail : '',
    };
  }

  /** Invalidate the prompt-injection cache after a memory mutation. */
  function invalidate(invocation) {
    try {
      const sessionId = invocation?.agent?.id;
      if (typeof runtime?.invalidateInjection === 'function' && typeof sessionId === 'string') {
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
   * `subagentWriteMode:'off'`. Returns a failed CommandResult or null.
   */
  function subagentGuard(invocation) {
    const effective = runtime?.config && typeof runtime.config === 'object' ? runtime.config : {};
    if (!subagentWriteBlocked(invocation?.agent, effective)) return null;
    return fail('subagent-readonly: this subagent session cannot write memory (subagentWriteMode: off)');
  }

  // -- /memory subcommands ---------------------------------------------------

  async function memoryStatus(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const { pctx, config, overrides, rules, index, entries, userEntries, snapshot, trashCount } = status;
    const sessionView = status.session ?? { live: false, mode: 'auto' };
    const lines = [];
    lines.push(`cc-memory v${VERSION} — auto memory & dreaming`);
    lines.push(`project: ${pctx.paths.projectRoot || '(unknown)'}`);
    lines.push(`memory:  ${pctx.paths.memoryDir || '(unavailable)'}`);
    lines.push(
      `plugin: ${config.enabled ? 'enabled' : 'disabled'}   auto memory: ${config.autoMemoryEnabled ? 'ON' : 'OFF'}   auto dream: ${config.autoDreamEnabled ? 'ON' : 'OFF'}   dream mode: ${config.dreamMode === 'review' ? 'review' : 'apply'}`,
    );
    lines.push(`injection: ${config.injectionMode === 'live' ? 'live (refresh on change)' : 'session (injected once, frozen)'}   subagents: ${config.injectSubagents === false ? 'not injected' : 'injected'}`);
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
      `entries: ${entries.length}${config.userMemoryEnabled ? `   user entries: ${userEntries.length} (${Number(config.userIndexMaxLines) || 30} lines / ${formatBytes(Number(config.userIndexMaxBytes) || 4096)})` : '   user scope: disabled'}   trash: ${Number(trashCount) || 0} file(s)`,
    );
    const pendingView = status.pendingWrites ?? { count: 0, items: [] };
    lines.push(
      `write review: ${Number(pendingView.count) || 0} pending (writeMode: ${config.writeMode === 'confirm' ? 'confirm' : 'auto'})   session injection: ${sessionView.live ? 'live' : 'auto'}`,
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
        `subagent policy: inject ${policy.injectSubagents === false ? 'OFF' : 'ON'}   writes ${policy.mode === 'off' ? 'OFF (read-only)' : 'shared'}`,
      );
    }
    lines.push(
      `last dream: ${formatTime(snapshot.lastDreamAt)}${Number(snapshot.lastDreamAt) > 0 ? ` (${formatAge(snapshot.lastDreamAt)})` : ''}${Number(snapshot.lastDreamOps) > 0 ? `, ops: ${snapshot.lastDreamOps}` : ''}${typeof snapshot.lastDreamMode === 'string' && snapshot.lastDreamMode !== '' ? `, mode: ${snapshot.lastDreamMode}` : ''}`,
    );
    if (Number(snapshot.lastDreamSessions) > 0) {
      lines.push(`last dream sessions: ${snapshot.lastDreamSessions}`);
    }
    if (typeof snapshot.pendingProposal === 'string' && snapshot.pendingProposal !== '') {
      lines.push(`pending proposal: ${snapshot.pendingProposal} (apply with /memory dream apply, discard with /memory dream reject)`);
    }
    if (typeof snapshot.lastPlanPath === 'string' && snapshot.lastPlanPath !== '') {
      lines.push(`last dry-run plan: ${snapshot.lastPlanPath} (apply with /memory dream apply)`);
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
      'Commands: /memory json | list | show <file> | index | metrics | writes | approve <id> | reject <id>',
    );
    lines.push('          /memory refresh | live on|off | user on|off | on | off | plugin on|off | rules [reset] | delete <file>');
    lines.push('          /memory backups | trash | restore <backup|trash> <id> [file]');
    lines.push('          /memory dream on|off|status|run [--dry-run]|apply|reject|preview|apply-ops <indexes>');
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
    const { config, entries, userEntries, snapshot } = status;
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
    if (config.userMemoryEnabled) {
      lines.push('');
      lines.push(`user scope — ${userEntries.length} ${userEntries.length === 1 ? 'entry' : 'entries'}`);
      if (userEntries.length === 0) lines.push('(no user memories yet)');
      for (const entry of sortedEntries(userEntries)) {
        const via = entry.via ? `  · via ${entry.via}` : '';
        lines.push(`- ${entry.file}  [${entry.type}] ${entry.name}${via}`);
      }
    } else {
      lines.push('');
      lines.push('user scope is disabled (userMemoryEnabled: false)');
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
      return fail('usage: /memory show <file> [--scope=project|user]');
    }
    const scope = String(flags.scope ?? 'project').toLowerCase() === 'user' ? 'user' : 'project';
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    if (scope === 'user' && !status.config.userMemoryEnabled) {
      return fail('user scope is disabled (set userMemoryEnabled: true in the plugin config)');
    }
    try {
      const entry = await service.file(status.pctx, file, scope);
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
    if (!runtime || typeof runtime.setOverrides !== 'function') {
      return fail('runtime switch overrides are unavailable in this build');
    }
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
          await service.resetRules(status.pctx, layer.scope, { source: 'command:/memory rules reset' });
          if (existed) removed += 1;
        } catch (error) {
          if (existed) warn(`rules reset ${layer.scope}`, error);
        }
      }
      try {
        if (typeof runtime?.invalidateAllInjections === 'function') runtime.invalidateAllInjections();
        else invalidate(invocation);
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
      return fail('usage: /memory delete <file> [--scope=project|user]');
    }
    const scope = String(flags.scope ?? 'project').toLowerCase() === 'user' ? 'user' : 'project';
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    if (scope === 'user' && !status.config.userMemoryEnabled) {
      return fail('user scope is disabled (set userMemoryEnabled: true in the plugin config)');
    }
    try {
      // Soft delete: the shared service moves the file into the project trash
      // instead of destroying it, so a mistaken `/memory delete` stays recoverable.
      const result = await service.deleteFile(status.pctx, file, scope);
      invalidate(invocation);
      const target = typeof result.trashPath === 'string' && result.trashPath !== ''
        ? ` -> ${result.trashPath}`
        : '';
      return ok(`trashed ${scope} memory file ${file}${target}`);
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
    if (['run', 'apply', 'reject', 'apply-ops', 'undo'].includes(sub)) {
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
        const when = Number(item.appliedAt) > 0 ? formatTime(item.appliedAt) : formatTime(item.at);
        lines.push(
          `- ${item.ts}  ${when}  ${item.undoable ? 'undoable' : item.hasMeta ? 'read-only' : 'legacy (no meta)'}`,
        );
        if (item.kind !== '') lines.push(`  kind: ${item.kind}   ops: ${Number(item.ops) || 0}`);
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
    if (sub === 'status') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      const { config, snapshot } = status;
      const sessions = Array.isArray(snapshot.sessionsSince) ? snapshot.sessionsSince.length : 0;
      const counters = snapshot.counters && typeof snapshot.counters === 'object' ? snapshot.counters : {};
      const lines = [];
      lines.push('dream status');
      lines.push(
        `auto dream: ${config.autoDreamEnabled ? 'ON' : 'OFF'}   mode: ${config.dreamMode === 'review' ? 'review' : 'apply'}   delete allowed: ${config.dreamAllowDelete ? 'yes' : 'no'}`,
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
      if (typeof snapshot.pendingProposal === 'string' && snapshot.pendingProposal !== '') {
        lines.push(`pending proposal: ${snapshot.pendingProposal} (apply with /memory dream apply, discard with /memory dream reject)`);
      } else {
        lines.push('pending proposal: none');
      }
      if (typeof snapshot.lastPlanPath === 'string' && snapshot.lastPlanPath !== '') {
        lines.push(`last dry-run plan: ${snapshot.lastPlanPath} (apply with /memory dream apply)`);
      } else {
        lines.push('last dry-run plan: none');
      }
      if (typeof snapshot.lastError === 'string' && snapshot.lastError !== '') {
        lines.push(`last error: ${snapshot.lastError}`);
      }
      lines.push('');
      lines.push('Run /memory dream run [--dry-run] [--focus <text>] to consolidate now, or /memory dream apply to apply a review-mode proposal.');
      return ok(lines.join('\n'));
    }
    if (sub === 'run') {
      const dryRun = flags['dry-run'] === true || flags.dryrun === true || flags.dry === true;
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, {
          agent: invocation.agent,
          sessionId: invocation?.agent?.id,
          action: dryRun ? 'dry-run' : 'run',
          trigger: 'manual',
          focus: typeof flags.focus === 'string' ? flags.focus : '',
        });
      } catch (error) {
        return fail(`dream run: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream run: ${response.message || response.error}`);
      invalidate(invocation);
      return ok(formatDreamRun(response.result, dryRun));
    }
    if (sub === 'apply') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      const { snapshot } = status;
      const pending = typeof snapshot.pendingProposal === 'string' ? snapshot.pendingProposal : '';
      const lastPlan = typeof snapshot.lastPlanPath === 'string' ? snapshot.lastPlanPath : '';
      let response;
      let source;
      if (pending !== '') {
        source = 'pending proposal';
        try {
          response = await service.dream(status.pctx, { agent: invocation.agent, action: 'apply-pending' });
        } catch (error) {
          return fail(`dream apply: ${errorText(error)}`);
        }
      } else if (lastPlan !== '') {
        source = 'last dry-run plan';
        try {
          response = await service.dream(status.pctx, { agent: invocation.agent, action: 'apply-last' });
        } catch (error) {
          return fail(`dream apply: ${errorText(error)}`);
        }
      } else {
        return fail(
          'nothing to apply: no pending proposal and no dry-run plan. Run /memory dream run --dry-run first.',
        );
      }
      if (!response.ok) return fail(`dream apply: ${response.message || response.error}`);
      invalidate(invocation);
      return ok(formatDreamApply(response.result, source));
    }
    if (sub === 'reject') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action: 'reject' });
      } catch (error) {
        return fail(`dream reject: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream reject: ${response.message || response.error}`);
      invalidate(invocation);
      const rejected = response.result ?? {};
      if (rejected.rejected === true) {
        return ok(`rejected and removed the pending dream proposal: ${rejected.proposalPath}`);
      }
      return fail('no pending proposal to reject');
    }
    if (sub === 'preview') {
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, { agent: invocation.agent, action: 'preview' });
      } catch (error) {
        return fail(`dream preview: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream preview: ${response.message || response.error}`);
      return ok(formatDreamPreview(response.result));
    }
    if (sub === 'apply-ops') {
      const rawIndexes =
        positional.slice(1).join(',') ||
        (typeof flags.indexes === 'string' ? flags.indexes : '');
      if (String(rawIndexes).trim() === '') {
        return fail(
          'usage: /memory dream apply-ops <indexes>  (comma-separated operation numbers, e.g. 0,2,3; see /memory dream preview)',
        );
      }
      const status = await collectStatus(invocation);
      if (!status.ok) return fail(`cc-memory: ${status.error}`);
      let response;
      try {
        response = await service.dream(status.pctx, {
          agent: invocation.agent,
          action: 'apply-ops',
          indexes: rawIndexes,
        });
      } catch (error) {
        return fail(`dream apply-ops: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream apply-ops: ${response.message || response.error}`);
      invalidate(invocation);
      return ok(formatDreamApply(response.result, 'selected operations'));
    }
    return fail('usage: /memory dream on|off|status|run [--dry-run]|apply|reject|preview|apply-ops <indexes>');
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

  // -- v9: write review queue + session controls -----------------------------

  /** `/memory writes`: list the writes waiting for human review. */
  async function memoryWrites(invocation) {
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    const pending = status.pendingWrites ?? { count: 0, items: [] };
    if ((Number(pending.count) || 0) === 0) {
      return ok('no pending writes — every memory write was applied automatically');
    }
    const lines = [`pending writes — ${Number(pending.count)}`];
    for (const item of pending.items.slice(0, 40)) {
      lines.push(
        `- ${item.id}  [${item.candidate?.type || '?'}] ${item.candidate?.name || '(unnamed)'}  ${formatTime(item.createdAt)}`,
      );
      if (item.candidate?.description) lines.push(`  ${truncate(item.candidate.description, 120)}`);
      if (Array.isArray(item.reasons) && item.reasons.length > 0) {
        lines.push(`  reasons: ${item.reasons.join('; ')}`);
      }
    }
    if (pending.items.length > 40) lines.push(`… ${pending.items.length - 40} more`);
    lines.push('');
    lines.push('Approve: /memory approve <id>   Reject: /memory reject <id> [reason]');
    return ok(lines.join('\n'));
  }

  async function memoryApprove(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { positional } = splitFlags(args);
    const id = positional[0];
    if (typeof id !== 'string' || id === '') return fail('usage: /memory approve <id>');
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    try {
      const result = await service.approveWrite(status.pctx, id, { sessionId: invocation?.agent?.id });
      invalidate(invocation);
      return ok(`approved pending write ${result.id} → ${result.file}`);
    } catch (error) {
      return fail(`memory approve ${id}: ${errorText(error)}`);
    }
  }

  async function memoryReject(invocation, args) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const { positional } = splitFlags(args);
    const id = positional[0];
    if (typeof id !== 'string' || id === '') return fail('usage: /memory reject <id> [reason]');
    const reason = positional.slice(1).join(' ');
    const status = await collectStatus(invocation);
    if (!status.ok) return fail(`cc-memory: ${status.error}`);
    try {
      const result = await service.rejectWrite(status.pctx, id, reason);
      const target = typeof result.path === 'string' && result.path !== '' ? ` → ${result.path}` : '';
      return ok(`rejected pending write ${result.id}${reason !== '' ? ` (${reason})` : ''}${target}`);
    } catch (error) {
      return fail(`memory reject ${id}: ${errorText(error)}`);
    }
  }

  /** `/memory refresh`: rebuild this session's injected memory text immediately. */
  async function memoryRefresh(invocation) {
    const sessionId = invocation?.agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return fail('memory refresh: no live session id');
    if (typeof runtime?.refreshSession !== 'function') {
      return fail('memory refresh: this host build cannot refresh a session injection');
    }
    try {
      const result = await runtime.refreshSession(sessionId);
      if (typeof runtime.drain === 'function') {
        try {
          await runtime.drain();
        } catch (error) {
          warn('drain', error);
        }
      }
      const live =
        typeof runtime.sessionMode === 'function' ? runtime.sessionMode(sessionId) === 'live' : result?.live === true;
      const text =
        typeof runtime.getInjectedText === 'function'
          ? String(runtime.getInjectedText(sessionId) ?? '')
          : '';
      const lines = [`injection refreshed (${live ? 'live' : 'auto'} mode) — ${text.length} chars`];
      if (text !== '') lines.push('', truncate(text, 800));
      return ok(lines.join('\n'));
    } catch (error) {
      return fail(`memory refresh: ${errorText(error)}`);
    }
  }

  /** `/memory live on|off`: per-session live injection mode. */
  async function memoryLive(invocation, args) {
    const value = String(args?.[0] ?? '').toLowerCase();
    if (value !== 'on' && value !== 'off') return fail('usage: /memory live on|off');
    const sessionId = invocation?.agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return fail('memory live: no live session id');
    if (typeof runtime?.setSessionMode !== 'function') {
      return fail('memory live: this host build cannot switch the session injection mode');
    }
    try {
      const mode = runtime.setSessionMode(sessionId, value === 'on' ? 'live' : 'auto');
      const detail =
        mode === 'live'
          ? 'refreshes on every memory change'
          : 'follows the plugin injectionMode setting';
      return ok(`this session's injection mode: ${mode} (${detail})`);
    } catch (error) {
      return fail(`memory live ${value}: ${errorText(error)}`);
    }
  }

  /** `/memory user on|off`: global runtime override for the user memory space. */
  async function memoryUser(invocation, args) {
    const value = String(args?.[0] ?? '').toLowerCase();
    if (value !== 'on' && value !== 'off') return fail('usage: /memory user on|off');
    let toggled;
    try {
      toggled = await service.toggle(runtime, { userMemoryEnabled: value === 'on' });
    } catch (error) {
      return fail(`memory user ${value}: ${errorText(error)}`);
    }
    invalidate(invocation);
    const effective = Boolean(runtime?.config?.userMemoryEnabled ?? toggled?.config?.userMemoryEnabled);
    const maxLines = Number(runtime?.config?.userIndexMaxLines) || 30;
    const maxBytes = Number(runtime?.config?.userIndexMaxBytes) || 4096;
    return ok(
      `user memory ${effective ? 'ON' : 'OFF'} (runtime override; applies to every project). Budget: ${maxLines} lines / ${formatBytes(maxBytes)}`,
    );
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
    for (const key of ['name', 'type', 'description', 'content', 'scope']) {
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
    const scope = parsed.scope === 'user' ? 'user' : 'project';
    let pctx;
    try {
      pctx = await requireProject(invocation);
    } catch (error) {
      return fail(`remember: ${errorText(error)}`);
    }
    const config = runtime.config && typeof runtime.config === 'object' ? runtime.config : {};
    if (scope === 'user' && !config.userMemoryEnabled) {
      return fail('user scope is disabled (set userMemoryEnabled: true in the plugin config)');
    }
    const name = deriveName(parsed.text);
    const description = firstLine(parsed.text);
    try {
      const saved = await pctx.store.saveEntry({
        scope,
        name,
        type,
        description,
        content: parsed.text,
        source: { sessionId: invocation?.agent?.id, via: 'command:/remember' },
      });
      invalidate(invocation);
      if (typeof saved?.file === 'string' && saved.file !== '') {
        // Effect metrics: every saved note counts as one write.
        await recordWrite(pctx.paths, saved.file);
      }
      const lines = [`saved ${scope} memory: ${typeof saved?.file === 'string' ? saved.file : name}`];
      lines.push(`type: ${typeof saved?.type === 'string' ? saved.type : type}   name: ${typeof saved?.name === 'string' ? saved.name : name}`);
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
              '       /dream run [--dry-run] [--focus <text>]|status|apply|history|undo   (short alias for /memory dream …)',
              '       /memory dream on|off|status|history|undo|run [--dry-run]|apply|reject|preview|apply-ops <indexes>',
              '       /memory backups | trash | restore <backup|trash> <id> [file]',
              '       /memory metrics   (injections, reads, writes, searches, dream acceptance, 7-day trend, quality, last cost)',
              '       /memory search <query> | show <file> | history <file> | edit <file> | merge <file1> <file2> [...]',
              '       /memory import <path> | export <path>   (Claude Code memory interoperability)',
              '       /memory writes | approve <id> | reject <id> [reason]   (write-review queue)',
              '       /memory refresh | live on|off | user on|off',
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
        case 'writes':
          return await memoryWrites(invocation);
        case 'approve':
          return await memoryApprove(invocation, args);
        case 'reject':
          return await memoryReject(invocation, args);
        case 'refresh':
          return await memoryRefresh(invocation);
        case 'live':
          return await memoryLive(invocation, args);
        case 'user':
          return await memoryUser(invocation, args);
        case 'backups':
          return await memoryBackups(invocation);
        case 'trash':
          return await memoryTrash(invocation);
        case 'restore':
          return await memoryRestore(invocation, args);
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
    description: 'Save one durable memory note for this project (/remember [--type=..] [--scope=..] text).',
    input: { hint: REMEMBER_HINT },
    handler: handleRemember,
  });
  register({
    name: 'dream',
    // Short human entry point for the same feature the Memory page calls Dream.
    description: 'Dream: consolidate memory now (/dream run [--dry-run] [--focus <text>] | status | apply | history | undo).',
    input: { hint: 'run [--dry-run]|status|apply|history|undo' },
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

/** Render one `DreamRunResult` as chat text. */
function formatDreamRun(result, dryRun) {
  if (!result || typeof result !== 'object') return 'dream run: the engine returned no result';
  const lines = [];
  lines.push(`dream run${dryRun ? ' (dry-run)' : ''}`);
  if (result.ran === false) {
    lines.push(`skipped: ${result.skipReason ?? 'unknown reason'}`);
    if (result.error) lines.push(`error: ${errorText(result.error)}`);
    return lines.join('\n');
  }
  lines.push(`mode: ${result.mode === 'review' ? 'review' : 'apply'}   applied: ${result.applied ? 'yes' : 'no'}`);
  lines.push(`sessions reviewed: ${Number(result.sessionsReviewed) || 0}`);
  const operations = Array.isArray(result.operations) ? result.operations : [];
  const operationCount = Array.isArray(result.operations)
    ? result.operations.length
    : Number(result.operations) || 0;
  lines.push(`operations: ${operationCount}`);
  for (const operation of operations.slice(0, 40)) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const target = op.file ?? op.name ?? '';
    const prefix = String(op.op ?? 'op');
    lines.push(`  - ${prefix}${target ? ` ${target}` : ''}${op.reason ? ` (${truncate(op.reason, 100)})` : ''}`);
  }
  if (operations.length > 40) lines.push(`  … ${operations.length - 40} more`);
  const touched = Array.isArray(result.filesTouched) ? result.filesTouched.length : result.filesTouched;
  if (touched !== undefined) lines.push(`files touched: ${touched}`);
  if (result.summary) lines.push(`summary: ${String(result.summary)}`);
  if (result.proposalPath) lines.push(`proposal: ${result.proposalPath}`);
  if (result.backupDir) lines.push(`backup: ${result.backupDir}`);
  if (result.error) lines.push(`error: ${errorText(result.error)}`);
  if (dryRun) lines.push('dry-run: no memory file was changed; review with /memory dream preview, then /memory dream apply.');
  return lines.join('\n');
}

/** Render one `applyPendingDream`/`applyLastPlan` result as chat text. */
function formatDreamApply(result, source = '') {
  if (!result || typeof result !== 'object') return 'dream apply: the engine returned no result';
  const lines = [];
  lines.push(`dream apply${source !== '' ? ` (${source})` : ''}: ${result.applied === true ? 'applied' : 'not applied'}`);
  if (result.rolledBack === true) lines.push('rolled back: yes (memory was restored from the pre-dream backup)');
  if (typeof result.mode === 'string' && result.mode !== '') lines.push(`mode: ${result.mode}`);
  const operations = Array.isArray(result.operations) ? result.operations : [];
  if (operations.length > 0) lines.push(`operations: ${operations.length}`);
  if (result.summary) lines.push(`summary: ${String(result.summary)}`);
  if (result.error) lines.push(`error: ${errorText(result.error)}`);
  if (result.applied === true) lines.push('The applied plan is now part of memory and its pending state was cleared.');
  return lines.join('\n');
}

/** Render one `runtime.previewPlan` result as chat text. */
function formatDreamPreview(result) {
  if (!result || typeof result !== 'object') return 'dream preview: the engine returned no plan';
  const lines = ['dream preview (no memory file was changed)'];
  if (typeof result.path === 'string' && result.path !== '') lines.push(`plan: ${result.path}`);
  if (result.summary) lines.push(`summary: ${truncate(String(result.summary), 400)}`);
  const ops = Array.isArray(result.ops) ? result.ops : [];
  lines.push(`operations: ${ops.length}`);
  for (const operation of ops.slice(0, 40)) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const target = typeof op.file === 'string' && op.file !== '' ? ` ${op.file}` : '';
    const changed = op.changed === false ? 'unchanged' : 'changed';
    lines.push(`  [${op.index ?? '?'}] ${String(op.op ?? 'op')}${target} (${changed})`);
    for (const item of (Array.isArray(op.evidence) ? op.evidence : []).slice(0, 3)) {
      const quote = typeof item === 'string' ? item : item?.quote;
      if (typeof quote === 'string' && quote !== '') lines.push(`      quote: "${truncate(quote, 120)}"`);
    }
  }
  if (ops.length > 40) lines.push(`  … ${ops.length - 40} more`);
  const truncated = Array.isArray(result.truncatedFiles) ? result.truncatedFiles : [];
  if (truncated.length > 0) lines.push(`truncated input files (protected from rewrite): ${truncated.join(', ')}`);
  const dropped = Array.isArray(result.dropped) ? result.dropped : [];
  if (dropped.length > 0) lines.push(`dropped operations: ${dropped.slice(0, 5).join('; ')}`);
  lines.push('');
  lines.push('Apply selected: /memory dream apply-ops <indexes>  (comma-separated operation numbers)');
  return lines.join('\n');
}
