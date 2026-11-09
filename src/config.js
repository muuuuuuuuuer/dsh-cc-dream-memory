/**
 * Configuration resolution for dsh-cc-dream-memory.
 *
 * The row's raw config is untrusted input: every field is validated, clamped and
 * defaulted here so the rest of the plugin can assume a complete frozen shape.
 * No external schema library is used: a local bundle must only import Node
 * builtins.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  autoMemoryEnabled: true,
  memoryRoot: '',
  userMemoryEnabled: false,
  injectIndex: true,
  // Attach memories clearly related to a user message to that step.
  autoRecall: true,
  autoRecallMaxFiles: 3,
  autoRecallMaxChars: 3_000,
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
  injectionMode: 'session',
  autoDreamEnabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMs: 10 * 60 * 1000,
  lockTtlMs: 60 * 60 * 1000,
  dreamMode: 'apply',
  dreamProvider: '',
  dreamModel: '',
  dreamAllowDelete: true,
  dreamMaxOps: 40,
  dreamInputMaxChars: 96_000,
  dreamMaxFileChars: 20_000,
  dreamMaxSessionChars: 12_000,
  // Tool evidence kept per transcript chunk: errors first, then evenly spread pairs.
  dreamMaxToolChars: 4_000,
  // Long sessions are read in chunks of this size, up to this many per dream.
  dreamMapChunkChars: 24_000,
  dreamMapMaxChunks: 12,
  sessionLookback: 8,
  tools: true,
  commands: true,
  ui: true,
  // Claude Code does not load project memory into subagents by default; a
  // subagent write still shares the project store unless subagentWriteMode=off.
  injectSubagents: false,
  contextOrder: 850,
  maxContentBytes: 128 * 1024,
  llmMaxTokens: 16384,
  rulesMaxChars: 8000,
  secretScan: 'warn',
  dreamMaxTotalTokens: 0,
  writeMode: 'auto',
  policyDuplicateThreshold: 0.82,
  policySuggestThreshold: 0.55,
  pendingProposalTtlHours: 72,
  dreamCostMode: 'warn',
  projectId: '',
  userIndexMaxLines: 30,
  userIndexMaxBytes: 4096,
  compactionDigest: true,
  subagentWriteMode: 'off',
  keepHistory: true,
  /** Evaluation harness only: registers an admin dream tool. Never enabled by default. */
  evalMode: false,
  historyMaxPerFile: 20,
  refreshIntervalMs: 30_000,
});

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function integer(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function text(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** Clamp one 0..1 fraction (similarity thresholds). */
function fraction(value, fallback, { min = 0, max = 1 } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function choice(value, fallback, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * Resolve the row config into the complete runtime shape.
 * @param {unknown} raw row config from cordis.patch.yml (may be undefined).
 * @returns {Readonly<typeof DEFAULTS>} frozen config.
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dreamMode = choice(input.dreamMode, DEFAULTS.dreamMode, ['apply', 'review']);
  const dreamProvider = text(input.dreamProvider, DEFAULTS.dreamProvider).trim();
  const dreamModel = text(input.dreamModel, DEFAULTS.dreamModel).trim();
  const pair = dreamProvider !== '' && dreamModel !== '';

  const config = {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    autoMemoryEnabled: bool(input.autoMemoryEnabled, DEFAULTS.autoMemoryEnabled),
    memoryRoot: text(input.memoryRoot, DEFAULTS.memoryRoot).trim(),
    userMemoryEnabled: bool(input.userMemoryEnabled, DEFAULTS.userMemoryEnabled),
    injectIndex: bool(input.injectIndex, DEFAULTS.injectIndex),
    injectionMode: choice(input.injectionMode, DEFAULTS.injectionMode, ['session', 'live']),
    indexMaxLines: integer(input.indexMaxLines, DEFAULTS.indexMaxLines, { min: 1, max: 100_000 }),
    indexMaxBytes: integer(input.indexMaxBytes, DEFAULTS.indexMaxBytes, { min: 256, max: 10 * 1024 * 1024 }),
    autoDreamEnabled: bool(input.autoDreamEnabled, DEFAULTS.autoDreamEnabled),
    minHours: integer(input.minHours, DEFAULTS.minHours, { min: 0, max: 24 * 365 }),
    minSessions: integer(input.minSessions, DEFAULTS.minSessions, { min: 1, max: 100_000 }),
    scanThrottleMs: integer(input.scanThrottleMs, DEFAULTS.scanThrottleMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    lockTtlMs: integer(input.lockTtlMs, DEFAULTS.lockTtlMs, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }),
    dreamMode,
    dreamProvider: pair ? dreamProvider : '',
    dreamModel: pair ? dreamModel : '',
    dreamAllowDelete: bool(input.dreamAllowDelete, DEFAULTS.dreamAllowDelete),
    dreamMaxOps: integer(input.dreamMaxOps, DEFAULTS.dreamMaxOps, { min: 1, max: 500 }),
    dreamInputMaxChars: integer(input.dreamInputMaxChars, DEFAULTS.dreamInputMaxChars, { min: 4096, max: 1_000_000 }),
    dreamMaxFileChars: integer(input.dreamMaxFileChars, DEFAULTS.dreamMaxFileChars, { min: 1000, max: 500_000 }),
    dreamMaxSessionChars: integer(input.dreamMaxSessionChars, DEFAULTS.dreamMaxSessionChars, { min: 800, max: 100_000 }),
    autoRecall: bool(input.autoRecall, DEFAULTS.autoRecall),
    autoRecallMaxFiles: integer(input.autoRecallMaxFiles, DEFAULTS.autoRecallMaxFiles, { min: 1, max: 10 }),
    autoRecallMaxChars: integer(input.autoRecallMaxChars, DEFAULTS.autoRecallMaxChars, { min: 200, max: 20_000 }),
    dreamMapChunkChars: integer(input.dreamMapChunkChars, DEFAULTS.dreamMapChunkChars, { min: 2_000, max: 200_000 }),
    dreamMapMaxChunks: integer(input.dreamMapMaxChunks, DEFAULTS.dreamMapMaxChunks, { min: 1, max: 200 }),
  dreamMaxToolChars: integer(input.dreamMaxToolChars, DEFAULTS.dreamMaxToolChars, { min: 0, max: 20_000 }),
    sessionLookback: integer(input.sessionLookback, DEFAULTS.sessionLookback, { min: 0, max: 100 }),
    tools: bool(input.tools, DEFAULTS.tools),
    commands: bool(input.commands, DEFAULTS.commands),
    ui: bool(input.ui, DEFAULTS.ui),
    injectSubagents: bool(input.injectSubagents, DEFAULTS.injectSubagents),
    contextOrder: integer(input.contextOrder, DEFAULTS.contextOrder, { min: 0, max: 10_000 }),
    maxContentBytes: integer(input.maxContentBytes, DEFAULTS.maxContentBytes, { min: 1024, max: 10 * 1024 * 1024 }),
    llmMaxTokens: integer(input.llmMaxTokens, DEFAULTS.llmMaxTokens, { min: 256, max: 200_000 }),
    rulesMaxChars: integer(input.rulesMaxChars, DEFAULTS.rulesMaxChars, { min: 200, max: 64_000 }),
    secretScan: choice(input.secretScan, DEFAULTS.secretScan, ['warn', 'deny', 'off']),
    dreamMaxTotalTokens: integer(input.dreamMaxTotalTokens, DEFAULTS.dreamMaxTotalTokens, {
      min: 0,
      max: 10_000_000,
    }),
    writeMode: choice(input.writeMode, DEFAULTS.writeMode, ['auto', 'confirm']),
    policyDuplicateThreshold: fraction(input.policyDuplicateThreshold, DEFAULTS.policyDuplicateThreshold),
    policySuggestThreshold: fraction(input.policySuggestThreshold, DEFAULTS.policySuggestThreshold),
    pendingProposalTtlHours: integer(input.pendingProposalTtlHours, DEFAULTS.pendingProposalTtlHours, {
      min: 0,
      max: 24 * 365,
    }),
    dreamCostMode: choice(input.dreamCostMode, DEFAULTS.dreamCostMode, ['warn', 'review', 'block']),
    projectId: text(input.projectId, DEFAULTS.projectId).trim().slice(0, 200),
    userIndexMaxLines: integer(input.userIndexMaxLines, DEFAULTS.userIndexMaxLines, { min: 1, max: 10_000 }),
    userIndexMaxBytes: integer(input.userIndexMaxBytes, DEFAULTS.userIndexMaxBytes, {
      min: 256,
      max: 10 * 1024 * 1024,
    }),
    compactionDigest: bool(input.compactionDigest, DEFAULTS.compactionDigest),
    subagentWriteMode: choice(input.subagentWriteMode, DEFAULTS.subagentWriteMode, ['shared', 'off']),
    keepHistory: bool(input.keepHistory, DEFAULTS.keepHistory),
  evalMode: bool(input.evalMode, DEFAULTS.evalMode),
    historyMaxPerFile: integer(input.historyMaxPerFile, DEFAULTS.historyMaxPerFile, { min: 0, max: 200 }),
    refreshIntervalMs: integer(input.refreshIntervalMs, DEFAULTS.refreshIntervalMs, { min: 5000, max: 10 * 60 * 1000 }),
  };
  return Object.freeze(config);
}
