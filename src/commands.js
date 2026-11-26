/** Human-facing /memory and /remember commands. */
import { VERSION } from './meta.js';
import { createStatusService, recordUserConfirmedSave } from './status.js';
import { ensureCurrentStatus } from './write-review.js';
import { evaluateWrite, textSimilarity } from './policy.js';
import { loadPolicyEntries, policyCandidate } from './tools.js';

/** Root command names, also accepted by `parseCommandLine` with a leading slash. */
const MEMORY_NAME = 'memory';
const REMEMBER_NAME = 'remember';

/** Supported frontmatter types for a hand-written memory note. */
const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference']);

/** Fast membership check for the supported frontmatter types. */
const TYPE_SET = new Set(MEMORY_TYPES);

const MEMORY_HINT = '[search <query> | dream [action] | undo | session [use|learn on|off]]';
const DREAM_HINT = 'run|status|estimate|resume|cancel|diff|switch|discard';
/** Notes this similar to a /remember are listed for the user to compare. */
const RELATED_SIMILARITY = 0.35;
const REMEMBER_HINT = '[--type=user|feedback|project|reference] [--force] <text>';

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
 * `--type=` / `--force` flags followed by the free-form text.
 *
 * The text is sliced from the original string so internal whitespace,
 * punctuation and newlines survive untouched.
 *
 * @param {unknown} rawInput
 * @returns {{type: string, text: string, force?: true}}
 */
export function parseRememberInput(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput : '';
  const tokens = tokenize(raw);
  let type = 'user';
  let force = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].value;
    if (/^--force$/iu.test(token)) {
      force = true;
      index += 1;
      continue;
    }
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
  return force ? { type, text, force } : { type, text };
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
  const chars = Array.from(first);
  let clipped = chars.slice(0, 32).join('');
  // Do not end the name in the middle of a Latin word ("make" -> "mak").
  if (chars.length > 32 && /[\p{L}\p{N}]$/u.test(clipped) && /^[A-Za-z0-9]/u.test(chars[32])) {
    const cut = clipped.search(/[A-Za-z0-9_-]+$/u);
    if (cut > 0) clipped = clipped.slice(0, cut);
  }
  clipped = clipped.trim();
  return clipped === '' ? 'note' : clipped;
}

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

  /** Resolve this agent's project context, or throw one readable error. */
  async function requireProject(invocation) {
    const pctx = await runtime.forAgent(invocation?.agent);
    if (!pctx || !pctx.store || !pctx.paths) {
      throw new Error('the memory directory is unavailable for this session');
    }
    return pctx;
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

  /**
   * v10: `/memory` write commands refuse delegated subagents when
   * `subagentMemory:'off'`. Returns a failed CommandResult or null.
   */
  function subagentGuard(invocation) {
    if (runtime.canWriteMemory(invocation?.agent)) return null;
    return fail('subagent-readonly: this subagent session cannot write memory under the current subagentMemory policy');
  }

  async function memoryStatus(invocation) {
    const pctx = await requireProject(invocation);
    const status = await service.status(pctx, { sessionId: invocation?.agent?.id });
    const { config, index, state, session, archive } = status;
    const lines = [
      `cc-memory v${VERSION}`,
      `project: ${pctx.paths.projectRoot || '(unknown)'}`,
      `memory: ${pctx.paths.memoryDir}`,
      `plugin: ${config.enabled ? 'enabled' : 'disabled'}   auto memory: ${config.autoMemoryEnabled ? 'ON' : 'OFF'}   auto dream: ${config.autoDreamEnabled ? 'ON' : 'OFF'}`,
      `index: ${index.lines} lines, ${formatBytes(index.bytes)}${index.overflow ? ' (over budget)' : ''}   notes: ${status.entries.length}`,
    ];
    if (session) lines.push(`this conversation: use ${session.use ? 'ON' : 'OFF'}, learn ${session.learn ? 'ON' : 'OFF'}`);
    if (archive?.candidates?.length) {
      lines.push(`archive candidates: ${archive.candidates.slice(0, 8).map(({ file }) => file).join(', ')}`);
    }
    if (state.shadowPending) lines.push('Dream is ready to review in the Dream tab or via /memory dream diff <file>.');
    if (state.lastError) lines.push(`last Dream error: ${state.lastError}`);
    for (const warning of status.health?.warnings?.slice(0, 6) ?? []) lines.push(`warning: ${warning}`);
    lines.push(`Commands: /memory ${MEMORY_HINT}`, `          /remember ${REMEMBER_HINT}`);
    return ok(lines.join('\n'));
  }

  async function memoryUndo(invocation) {
    const blocked = subagentGuard(invocation);
    if (blocked) return blocked;
    const pctx = await requireProject(invocation);
    const response = await service.dream(pctx, { agent: invocation.agent, action: 'undo' });
    const result = response.result ?? {};
    if (!response.ok || result.ok === false || result.error) {
      return fail(`dream undo: ${result.error || response.message || response.error || 'no-undoable-batch'}`);
    }
    invalidate(invocation);
    return ok(`undid dream batch ${result.batch}: restored ${result.restored?.length ?? 0}, trashed ${result.trashed?.length ?? 0}`);
  }

  async function memoryDream(invocation, args) {
    const { flags, positional } = splitFlags(args);
    const sub = (positional[0] ?? 'status').toLowerCase();
    if (['run', 'resume', 'cancel', 'switch', 'discard'].includes(sub)) {
      const blocked = subagentGuard(invocation);
      if (blocked) return blocked;
    }
    const pctx = await requireProject(invocation);
    if (sub === 'estimate') {
      try {
        const response = await service.dream(pctx, { action: 'estimate', noSessions: flags['memory-only'] === true });
        if (!response.ok) return fail(`dream estimate: ${response.message || response.error}`);
        const estimate = response.result;
        return ok(`Dream rough input estimate: ${estimate.estimatedTokens} tokens\nActual usage depends on the work needed to finish.`);
      } catch (error) { return fail(`dream estimate: ${errorText(error)}`); }
    }
    if (sub === 'status' && !positional[1] && typeof flags.run !== 'string') {
      const status = await service.status(pctx, { sessionId: invocation?.agent?.id });
      const pending = status.state.shadowPending;
      const files = pending?.files ?? [];
      const lines = [
        'dream status',
        `auto dream: ${status.config.autoDreamEnabled ? 'ON' : 'OFF'}`,
        `last dream: ${formatTime(status.state.lastDreamAt)}`,
        `pending dream result: ${pending ? `${files.length} file(s)` : 'none'}`,
      ];
      for (const item of files) lines.push(`  - ${item.action}: ${item.file}`);
      if (pending) lines.push('Review with /memory dream diff <file>, then /memory dream switch or /memory dream discard.');
      if (status.state.lastError) lines.push(`last error: ${status.state.lastError}`);
      if (status.dreamRuns?.[0]) lines.push(formatDreamRunStatus(status.dreamRuns[0]));
      lines.push('Start with /memory dream run [--focus <text>] [--memory-only].');
      return ok(lines.join('\n'));
    }
    if (sub === 'run' || sub === 'resume') {
      // `--wait` blocks until the run finishes; otherwise it runs in the background.
      const wait = flags.wait === true;
      const resumeId = sub === 'resume' ? positional[1] : '';
      if (sub === 'resume' && !resumeId) return fail('usage: /memory dream resume <runId> [--wait]');
      let response;
      try {
        response = await service.dream(pctx, {
          agent: invocation.agent,
          sessionId: invocation?.agent?.id,
          action: resumeId ? 'resume' : wait ? 'run' : 'start',
          ...(resumeId ? { runId: resumeId, wait } : {}),
          trigger: 'manual',
          focus: typeof flags.focus === 'string' ? flags.focus : '',
          // `--memory-only` tidies the saved pages and reads no conversation.
          noSessions: flags['memory-only'] === true,
        });
      } catch (error) {
        return fail(`dream run: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream run: ${response.message || response.error}`);
      invalidate(invocation);
      if (wait) return response.result?.ran === undefined && response.result?.ok === false
        ? fail(`dream ${sub}: ${response.result.error}`) : ok(formatDreamRun(response.result));
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
          'the run continues in the background; stopping it throws its copy away, and live memory is never touched before you switch.',
        ].join('\n'),
      );
    }
    if (sub === 'cancel' || sub === 'status') {
      const runId = positional[1] ?? (typeof flags.run === 'string' ? flags.run : '');
      const action = sub === 'cancel' ? 'cancel' : 'status';
      let response;
      try {
        response = await service.dream(pctx, { agent: invocation.agent, action, runId });
      } catch (error) {
        return fail(`dream ${action}: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream ${action}: ${response.message || response.error}`);
      if (action === 'cancel') {
        const result = response.result ?? {};
        // DreamAgent.cancel answers {ok:true, status:'cancelling'}.
        return result.ok === true
          ? ok(`dream run ${result.runId} is stopping; its copy is thrown away. Run /memory dream run to start again.`)
          : fail(`no running dream run${runId ? ` ${runId}` : ''} to cancel`);
      }
      return ok(formatDreamRunStatus(response.result));
    }
    if (sub === 'diff') {
      // Read one pending change before deciding on it (needed for --confirm).
      const file = positional[1] ?? '';
      if (file === '') return fail('usage: /memory dream diff <file>');
      const pending = pctx.state.snapshot().shadowPending;
      if (!pending) return fail('no pending dream result');
      let detail;
      try {
        detail = await service.dreamDiff(pctx, pending.runId, file);
      } catch (error) {
        return fail(`dream diff: ${errorText(error)}`);
      }
      const proof = (pending.proofs ?? []).find((item) => item.file === file);
      const lines = [`dream diff: ${file}`];
      const sourced = proof && proof.kind !== 'missing' && (proof.kind !== 'citation' || proof.unsupportedClaims?.length === 0);
      lines.push(sourced ? `source: ${proof.kind}` : 'source: needs direct confirmation (apply with --confirm)');
      for (const item of detail.removedLines ?? []) lines.push(`- ${item.text}`);
      for (const item of detail.addedLines ?? []) lines.push(`+ ${item.text}`);
      for (const item of detail.evidence ?? []) {
        lines.push(`evidence: ${item.memoryFile ?? `${item.sessionId}#${item.seq}`}${item.role || item.eventType ? ` (${item.role || item.eventType})` : ''} — ${item.quote}${item.verified ? '' : ' (not checked)'}`);
        for (const claim of item.claims ?? []) lines.push(`  supports: ${claim}`);
      }
      for (const claim of detail.unsupportedClaims) lines.push(`requires confirmation: ${claim}`);
      for (const item of pending.rejectedBefore?.[file] ?? []) lines.push(`rejected before: ${item}`);
      return ok(lines.join('\n'));
    }
    if (sub === 'switch') {
      let response;
      try {
        // `--reject a.md,b.md` keeps those files as they are; the rest is applied.
        // `--defer` leaves files out without remembering a rejection; `--confirm`
        // accepts files without a checked source after you read their diff.
        const list = (value) => (typeof value === 'string' ? value.split(',').map((file) => file.trim()).filter(Boolean) : []);
        const reject = list(flags.reject);
        response = await service.dream(pctx, {
          agent: invocation.agent, action: 'switch', reject, defer: list(flags.defer), confirm: list(flags.confirm),
        });
      } catch (error) {
        return fail(`dream switch: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream switch: ${response.message || response.error}`);
      invalidate(invocation);
      return ok(formatDreamSwitch(response.result));
    }
    if (sub === 'discard') {
      let response;
      try {
        response = await service.dream(pctx, { agent: invocation.agent, action: 'discard' });
      } catch (error) {
        return fail(`dream discard: ${errorText(error)}`);
      }
      if (!response.ok) return fail(`dream discard: ${response.message || response.error}`);
      const result = response.result ?? {};
      if (result.discarded === true) return ok('deferred the dream result; its sessions remain eligible');
      return fail(`dream discard: ${result.reason || result.error || 'nothing to discard'}`);
    }
    return fail(`unknown dream subcommand "${sub}".
usage: /memory dream ${DREAM_HINT}`);
  }

  async function memorySearch(invocation, args) {
    const { flags, positional } = splitFlags(args);
    const query = positional.join(' ').trim() || (typeof flags.q === 'string' ? flags.q.trim() : '');
    if (query === '') {
      return fail('usage: /memory search <query> [--type=user|feedback|project|reference] [--limit=10]');
    }
    const pctx = await requireProject(invocation);
    let result;
    try {
      result = await service.search(pctx, {
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
    let related = [];
    if (parsed.force !== true) {
      // A person typing gets a stop: a duplicate or an opposite fact is named
      // before it is saved (the model tools only report the same signals). Pages on the same subject are
      // listed so the user can see a contradiction the gate cannot detect.
      try {
        const candidate = policyCandidate({ name, type, description, content: parsed.text });
        const entries = await loadPolicyEntries(pctx.store, 'project', '', candidate);
        const decision = evaluateWrite({ candidate, entries, config });
        if (decision?.action === 'duplicate' || decision?.action === 'conflict') {
          const file = decision.action === 'duplicate' ? decision.existingFile : decision.conflicts?.[0]?.file;
          return fail([
            decision.action === 'duplicate'
              ? `remember: ${file} already covers this; edit that note instead.`
              : `remember: this contradicts ${file}; edit that note instead.`,
            'Add --force to save it anyway.',
          ].join('\n'));
        }
        related = entries
          .map((entry) => ({ entry, score: textSimilarity(`${name}\n${parsed.text}`, `${entry.name}\n${entry.description}`) }))
          .filter((item) => item.score >= RELATED_SIMILARITY)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map((item) => item.entry);
      } catch (error) {
        console.warn('[cc-memory] remember: write check failed:', error?.message ?? error);
      }
    }
    try {
      const saved = await pctx.store.saveEntry({
        name,
        type,
        description,
        // The human typed this themselves, so it is the current value without a
        // model-authored status line or a citation.
        content: ensureCurrentStatus(parsed.text),
        source: { sessionId: invocation?.agent?.id, via: 'command:/remember' },
      });
      invalidate(invocation);
      const verification = typeof saved?.file === 'string' && saved.file !== ''
        // The user typed this note themselves, so the saved bytes are the
        // confirmed value: count the write and mark it verified (the trust
        // badge in the Memory panel).
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
          ? 'verification: confirmed by you'
          : 'verification: pending (saved; the Memory panel shows it unverified)',
      );
      for (const entry of related) {
        lines.push(`related: ${entry.file} — ${entry.description || entry.name} (check that the two notes agree)`);
      }
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

  /** `/memory session [status | use on|off | learn on|off]`: per-conversation switches. */
  async function memorySession(invocation, args) {
    const sessionId = invocation?.agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return fail('session: there is no active conversation');
    const [sub = 'status', value] = args.map((item) => String(item).toLowerCase());
    const usage = 'usage: /memory session [status | use on|off | learn on|off]';
    const pctx = await requireProject(invocation);
    if (sub !== 'status') {
      if (!['use', 'learn'].includes(sub) || !['on', 'off'].includes(value)) return fail(usage);
      await service.setSessionFlag(pctx, { sessionId, key: sub, value: value === 'on' });
    }
    const flags = runtime.sessionFlags(pctx, sessionId);
    return ok([
      `use memory: ${flags.use ? 'ON' : 'OFF'}   (OFF: this conversation loads no memory and recalls nothing)`,
      `learn from this conversation: ${flags.learn ? 'ON' : 'OFF'}   (OFF: no auto-extract and Dream skips it; memory_save still works)`,
    ].join('\n'));
  }

  async function handleMemory(invocation) {
    try {
      const { verb, args } = parseCommandLine(invocation?.rawInput);
      switch (verb) {
        case '':
        case 'status':
          return await memoryStatus(invocation);
        case 'search':
          return await memorySearch(invocation, args);
        case 'dream':
          return await memoryDream(invocation, args);
        case 'undo':
          return args.length ? fail('usage: /memory undo') : await memoryUndo(invocation);
        case 'session':
          return await memorySession(invocation, args);
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

/** What a run covered: sessions reviewed and total tokens reported. */
function runProgressLine(run) {
  const offered = Array.isArray(run?.input?.sessions) ? run.input.sessions.length : Number(run?.sessionsOffered) || 0;
  const tokens = Number(run?.usage?.totalTokens) || 0;
  return `sessions: ${Number(run?.sessionsReviewed) || 0}/${offered} reviewed, tokens: ${tokens}`;
}

/** Render one resumable-run summary as chat text. */
function formatDreamRunStatus(run) {
  if (!run || typeof run !== 'object') return 'no dream run recorded';
  if (run.ok === false) return `dream status: ${run.error ?? 'unavailable'}${run.message ? ` — ${run.message}` : ''}`;
  if (run.status === 'none') return 'no dream runs recorded yet; start one with /memory dream run';
  const lines = [];
  lines.push(`dream run ${run.runId || '(unknown)'} — ${run.status || 'unknown'}${run.stage ? ` at ${run.stage}` : ''}`);
  lines.push(runProgressLine(run));
  for (const range of run.reviewRanges ?? []) {
    if ((range.throughSeq ?? -1) < range.lastSeq) {
      lines.push(`remaining ${range.id}: seq ${(range.throughSeq ?? -1) + 1}–${range.lastSeq}`);
    }
  }
  if (run.decision) lines.push(`review decision: ${run.decision}`);
  if (run.blockedReason) lines.push(`blocked: ${truncate(run.blockedReason, 300)}`);
  if (run.error) lines.push(run.error === 'checkpoint-unavailable'
    ? 'The saved checkpoint is missing or damaged.'
    : `error: ${truncate(run.error, 300)}`);
  if (run.skipReason) lines.push(`skipped: ${run.skipReason}`);
  const errors = Array.isArray(run.errors) ? run.errors : [];
  for (const item of errors.slice(0, 3)) {
    lines.push(`failed ${item.sessionId ?? '?'}: ${truncate(String(item.error ?? ''), 200)}`);
  }
  if (run.status === 'running') {
    lines.push(`stop: /memory dream cancel ${run.runId}`);
  } else if (run.resumable) {
    if (run.checkpointed > 0) lines.push(`sessions with saved analysis: ${run.checkpointed}`);
    lines.push(`continue: /memory dream resume ${run.runId}`);
  } else if (['failed', 'cancelled', 'blocked'].includes(run.status)) {
    lines.push('run again: /memory dream run');
  }
  return lines.join('\n');
}

/** Render one `DreamRunResult` as chat text. */
function formatDreamRun(result) {
  if (!result || typeof result !== 'object') return 'dream run: the engine returned no result';
  if (result.error === 'checkpoint-conflict') return 'The saved Dream analysis is out of date. Start a new run with /memory dream run.';
  const lines = [];
  lines.push('dream run');
  if (result.resumable) lines.push(`paused: continue with /memory dream resume ${result.runId}`);
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
  if (result.shadowDir) lines.push(`result kept in: ${result.shadowDir} (apply with /memory dream switch [--reject <file,...>] [--defer <file,...>] [--confirm <file,...>], defer with /memory dream discard)`);
  if (result.error) lines.push(`error: ${errorText(result.error)}`);
  if (Array.isArray(result.warnings)) for (const warning of result.warnings) lines.push(`warning: ${truncate(warning, 500)}`);
  return lines.join('\n');
}

/** Render one `switchShadow` result as chat text. */
function formatDreamSwitch(result) {
  if (!result || typeof result !== 'object') return 'dream switch: the engine returned no result';
  const lines = [];
  if (result.ok !== true) {
    lines.push(`dream switch: not switched (${errorText(result.error || result.reason || 'unknown')})`);
    if (result.error === 'wiki-links' && result.message) lines.push(result.message);
    if (result.error === 'evidence-required' && Array.isArray(result.files)) {
      lines.push(`no checked source for: ${result.files.join(', ')}`);
      lines.push('Read each diff with /memory dream diff <file>, then add --confirm <file,...> to accept it, --defer to leave it for later, or --reject to turn it down.');
    }
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
  if (Array.isArray(result.confirmedWithoutSource) && result.confirmedWithoutSource.length > 0) {
    lines.push(`accepted without a checked source: ${result.confirmedWithoutSource.join(', ')}`);
  }
  if (Array.isArray(result.deferred) && result.deferred.length > 0) lines.push(`left for later: ${result.deferred.join(', ')}`);
  if (result.backupDir) lines.push(`backup: ${result.backupDir}`);
  lines.push('undo with /memory undo');
  return lines.join('\n');
}
