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
  // Claude Code runs a per-turn selector that attaches up to five topic files.
  // `model` uses one cheap JSON call; `off` disables recall. There is no
  // second lexical ranker.
  recallMode: 'model',
  recallProvider: '',
  recallModel: '',
  recallTimeoutMs: 4_000,
  recallMaxCandidates: 200,
  autoRecallMaxFiles: 3,
  autoRecallMaxChars: 3_000,
  // Optional end-of-turn extraction. Every proposal is staged in the inbox for
  // human acceptance; there is no direct-write mode.
  autoExtract: false,
  autoExtractEveryTurns: 3,
  autoExtractMaxItems: 3,
  autoExtractMaxChars: 12_000,
  autoExtractTimeoutMs: 30_000,
  autoExtractProvider: '',
  autoExtractModel: '',
  // One policy for subagent memory: off (no injection, no writes), shared
  // (project store, read/write), own (agents/<preset>/memory, isolated).
  subagentMemory: 'off',
  agentMemoryPresets: [],
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
  autoDreamEnabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMs: 10 * 60 * 1000,
  lockTtlMs: 60 * 60 * 1000,
  dreamAnalyzerProvider: '',
  dreamAnalyzerModel: '',
  dreamAnalyzerConcurrency: 3,
  dreamAnalyzerMaxTokens: 8192,
  dreamAnalyzerMemoryChars: 12_000,
  dreamAllowDelete: true,
  dreamInputMaxChars: 96_000,
  dreamMaxFileChars: 100_000,
  // Tool evidence kept per transcript chunk: errors first, then evenly spread pairs.
  dreamMaxToolChars: 4_000,
  // Long sessions are read in chunks of this size, up to this many per dream.
  dreamMapChunkChars: 24_000,
  tools: true,
  commands: true,
  ui: true,
  // Claude Code does not load project memory into subagents by default.
  contextOrder: 850,
  maxContentBytes: 128 * 1024,
  rulesMaxChars: 8000,
  secretScan: 'warn',
  dreamMaxTotalTokens: 0,
  policyDuplicateThreshold: 0.82,
  policySuggestThreshold: 0.55,
  dreamCostMode: 'warn',
  projectId: '',
  keepHistory: true,
  /** Evaluation harness only: registers an admin dream tool. Never enabled by default. */
  evalMode: false,
  historyMaxPerFile: 20,
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
export function resolveConfig(raw, { env } = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const environment = env && typeof env === 'object' ? env : {};
  // Claude Code parity: this environment variable turns auto memory off for
  // every session, whatever the row config says.
  const offByEnv = ['1', 'true', 'yes', 'on'].includes(
    String(environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim().toLowerCase(),
  );
  // Normalize old profile keys at the configuration boundary. The runtime
  // sees one complete analyzer selection, or uses the host default.
  const analyzerProvider = text(input.dreamAnalyzerProvider, '').trim();
  const analyzerModel = text(input.dreamAnalyzerModel, '').trim();
  const provider = analyzerProvider && analyzerModel ? analyzerProvider : text(input.dreamProvider, '').trim();
  const model = analyzerProvider && analyzerModel ? analyzerModel : text(input.dreamModel, '').trim();
  const recallMode = offByEnv
    ? 'off'
    : choice(input.recallMode, DEFAULTS.recallMode, ['off', 'model']);
  const recallProvider = text(input.recallProvider, DEFAULTS.recallProvider).trim();
  const recallModel = text(input.recallModel, DEFAULTS.recallModel).trim();
  const recallPair = recallProvider !== '' && recallModel !== '';
  const extractProvider = text(input.autoExtractProvider, DEFAULTS.autoExtractProvider).trim();
  const extractModel = text(input.autoExtractModel, DEFAULTS.autoExtractModel).trim();
  const extractPair = extractProvider !== '' && extractModel !== '';
  const agentPresets = Array.isArray(input.agentMemoryPresets)
    ? input.agentMemoryPresets
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim().slice(0, 120))
    : DEFAULTS.agentMemoryPresets;

  const config = {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    autoMemoryEnabled: offByEnv ? false : bool(input.autoMemoryEnabled, DEFAULTS.autoMemoryEnabled),
    memoryRoot: text(input.memoryRoot, DEFAULTS.memoryRoot).trim(),
    indexMaxLines: integer(input.indexMaxLines, DEFAULTS.indexMaxLines, { min: 1, max: 100_000 }),
    indexMaxBytes: integer(input.indexMaxBytes, DEFAULTS.indexMaxBytes, { min: 256, max: 10 * 1024 * 1024 }),
    autoDreamEnabled: bool(input.autoDreamEnabled, DEFAULTS.autoDreamEnabled),
    minHours: integer(input.minHours, DEFAULTS.minHours, { min: 0, max: 24 * 365 }),
    minSessions: integer(input.minSessions, DEFAULTS.minSessions, { min: 1, max: 100_000 }),
    scanThrottleMs: integer(input.scanThrottleMs, DEFAULTS.scanThrottleMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    lockTtlMs: integer(input.lockTtlMs, DEFAULTS.lockTtlMs, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }),
    dreamAnalyzerProvider: model ? provider : '',
    dreamAnalyzerModel: provider ? model : '',
    dreamAnalyzerConcurrency: integer(input.dreamAnalyzerConcurrency, DEFAULTS.dreamAnalyzerConcurrency, { min: 1, max: 16 }),
    dreamAnalyzerMaxTokens: integer(input.dreamAnalyzerMaxTokens, DEFAULTS.dreamAnalyzerMaxTokens, { min: 512, max: 200_000 }),
    dreamAnalyzerMemoryChars: integer(input.dreamAnalyzerMemoryChars, DEFAULTS.dreamAnalyzerMemoryChars, { min: 1000, max: 1_000_000 }),
    dreamAllowDelete: bool(input.dreamAllowDelete, DEFAULTS.dreamAllowDelete),
    dreamInputMaxChars: integer(input.dreamInputMaxChars, DEFAULTS.dreamInputMaxChars, { min: 4096, max: 1_000_000 }),
    dreamMaxFileChars: integer(input.dreamMaxFileChars, DEFAULTS.dreamMaxFileChars, { min: 1000, max: 500_000 }),
    recallMode,
    recallProvider: recallPair ? recallProvider : '',
    recallModel: recallPair ? recallModel : '',
    recallTimeoutMs: integer(input.recallTimeoutMs, DEFAULTS.recallTimeoutMs, { min: 100, max: 120_000 }),
    recallMaxCandidates: integer(input.recallMaxCandidates, DEFAULTS.recallMaxCandidates, { min: 1, max: 2_000 }),
    autoRecallMaxFiles: integer(input.autoRecallMaxFiles, DEFAULTS.autoRecallMaxFiles, { min: 1, max: 10 }),
    autoRecallMaxChars: integer(input.autoRecallMaxChars, DEFAULTS.autoRecallMaxChars, { min: 200, max: 20_000 }),
    autoExtract: bool(input.autoExtract, DEFAULTS.autoExtract),
    autoExtractEveryTurns: integer(input.autoExtractEveryTurns, DEFAULTS.autoExtractEveryTurns, { min: 1, max: 1000 }),
    autoExtractMaxItems: integer(input.autoExtractMaxItems, DEFAULTS.autoExtractMaxItems, { min: 1, max: 10 }),
    autoExtractMaxChars: integer(input.autoExtractMaxChars, DEFAULTS.autoExtractMaxChars, { min: 1000, max: 200_000 }),
    autoExtractTimeoutMs: integer(input.autoExtractTimeoutMs, DEFAULTS.autoExtractTimeoutMs, { min: 1000, max: 300_000 }),
    autoExtractProvider: extractPair ? extractProvider : '',
    autoExtractModel: extractPair ? extractModel : '',
    subagentMemory: choice(input.subagentMemory, DEFAULTS.subagentMemory, ['off', 'shared', 'own']),
    agentMemoryPresets: agentPresets,
    dreamMapChunkChars: integer(input.dreamMapChunkChars, DEFAULTS.dreamMapChunkChars, { min: 2_000, max: 200_000 }),
  dreamMaxToolChars: integer(input.dreamMaxToolChars, DEFAULTS.dreamMaxToolChars, { min: 0, max: 20_000 }),
    tools: bool(input.tools, DEFAULTS.tools),
    commands: bool(input.commands, DEFAULTS.commands),
    ui: bool(input.ui, DEFAULTS.ui),
    contextOrder: integer(input.contextOrder, DEFAULTS.contextOrder, { min: 0, max: 10_000 }),
    maxContentBytes: integer(input.maxContentBytes, DEFAULTS.maxContentBytes, { min: 1024, max: 10 * 1024 * 1024 }),
    rulesMaxChars: integer(input.rulesMaxChars, DEFAULTS.rulesMaxChars, { min: 200, max: 64_000 }),
    secretScan: choice(input.secretScan, DEFAULTS.secretScan, ['warn', 'deny', 'off']),
    dreamMaxTotalTokens: integer(input.dreamMaxTotalTokens, DEFAULTS.dreamMaxTotalTokens, {
      min: 0,
      max: 10_000_000,
    }),
    policyDuplicateThreshold: fraction(input.policyDuplicateThreshold, DEFAULTS.policyDuplicateThreshold),
    policySuggestThreshold: fraction(input.policySuggestThreshold, DEFAULTS.policySuggestThreshold),
    dreamCostMode: choice(input.dreamCostMode, DEFAULTS.dreamCostMode, ['warn', 'block']),
    projectId: text(input.projectId, DEFAULTS.projectId).trim().slice(0, 200),
    keepHistory: bool(input.keepHistory, DEFAULTS.keepHistory),
  evalMode: bool(input.evalMode, DEFAULTS.evalMode),
    historyMaxPerFile: integer(input.historyMaxPerFile, DEFAULTS.historyMaxPerFile, { min: 0, max: 200 }),
  };
  return Object.freeze(config);
}
