/**
 * Tests for src/config.js (Lead-owned module, already implemented).
 *
 * Contract: INTERFACES.md "Config" — resolveConfig(raw) returns a frozen object
 * with the documented defaults, clamps numbers into sane ranges, and falls back
 * to defaults on invalid types.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers.mjs';

let configModulePromise;

function configModule() {
  if (!configModulePromise) {
    configModulePromise = loadModule('../src/config.js', { requireExports: ['resolveConfig', 'DEFAULTS'] });
  }
  return configModulePromise;
}

const DOCUMENTED_DEFAULTS = {
  enabled: true,
  autoMemoryEnabled: true,
  memoryRoot: '',
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
  autoDreamEnabled: false,
  minHours: 24,
  minSessions: 5,
  scanThrottleMs: 10 * 60 * 1000,
  lockTtlMs: 60 * 60 * 1000,
  dreamAnalyzerProvider: '',
  dreamAnalyzerModel: '',
  dreamAllowDelete: true,
  dreamInputMaxChars: 96_000,
  dreamMaxFileChars: 100_000,
  dreamMaxToolChars: 4_000,
  tools: true,
  commands: true,
  ui: true,
  subagentMemory: 'off',
  contextOrder: 850,
  maxContentBytes: 128 * 1024,
  dreamAnalyzerMaxTokens: 8192,
  rulesMaxChars: 8000,
};

test('resolveConfig() returns the documented defaults and a frozen object', async () => {
  const { resolveConfig } = await configModule();
  const config = resolveConfig();
  for (const [key, expected] of Object.entries(DOCUMENTED_DEFAULTS)) {
    assert.deepEqual(config[key], expected, `default value of config.${key}`);
  }
  assert.equal(Object.isFrozen(config), true, 'resolveConfig() must return a frozen object');
});

test('DEFAULTS export matches the documented defaults', async () => {
  const { DEFAULTS } = await configModule();
  assert.equal(typeof DEFAULTS, 'object');
  assert.equal(Object.isFrozen(DEFAULTS), true, 'DEFAULTS must be frozen');
  for (const [key, expected] of Object.entries(DOCUMENTED_DEFAULTS)) {
    assert.deepEqual(DEFAULTS[key], expected, `DEFAULTS.${key}`);
  }
});

test('resolveConfig tolerates undefined / null / non-object raw values', async () => {
  const { resolveConfig } = await configModule();
  const fromNothing = resolveConfig();
  for (const raw of [undefined, null, '', 'garbage', 42, [], true]) {
    assert.deepEqual(resolveConfig(raw), fromNothing, `resolveConfig(${JSON.stringify(raw)}) should equal defaults`);
  }
});

test('valid overrides are preserved verbatim', async () => {
  const { resolveConfig } = await configModule();
  const raw = {
    enabled: false,
    autoMemoryEnabled: false,
    memoryRoot: '~/custom-memory',
    indexMaxLines: 120,
    indexMaxBytes: 4096,
    autoDreamEnabled: true,
    minHours: 2,
    minSessions: 2,
    scanThrottleMs: 5000,
    lockTtlMs: 60_000,
      dreamAnalyzerProvider: 'local',
    dreamAnalyzerModel: 'small-model',
    dreamAllowDelete: true,
      dreamInputMaxChars: 10_000,
    dreamMaxFileChars: 15_000,
    tools: false,
    commands: false,
    ui: false,
    subagentMemory: 'shared',
    contextOrder: 100,
    maxContentBytes: 2048,
    dreamAnalyzerMaxTokens: 1024,
    rulesMaxChars: 4000,
  };
  const config = resolveConfig(raw);
  for (const [key, expected] of Object.entries(raw)) {
    assert.deepEqual(config[key], expected, `override config.${key}`);
  }
});

test('invalid types fall back to defaults', async () => {
  const { resolveConfig } = await configModule();
  const config = resolveConfig({
    enabled: 'no',
    autoMemoryEnabled: 'no',
    autoDreamEnabled: 'on',
    tools: 0,
    commands: '',
    ui: null,
    subagentMemory: 'sometimes',
    dreamAllowDelete: 'yes',
    indexMaxLines: 'many',
    indexMaxBytes: {},
    minHours: null,
    minSessions: Number.NaN,
    scanThrottleMs: undefined,
    lockTtlMs: Number.NaN,
      dreamInputMaxChars: null,
    dreamMaxFileChars: 'lots',
    contextOrder: null,
    maxContentBytes: 'huge',
    dreamAnalyzerMaxTokens: [],
    rulesMaxChars: [],
    memoryRoot: 42,
      dreamAnalyzerProvider: 7,
    dreamAnalyzerModel: null,
  });
  assert.equal(config.enabled, true, 'enabled (invalid string) falls back to default true');
  assert.equal(config.autoMemoryEnabled, true, 'autoMemoryEnabled (invalid string) falls back to default true');
  assert.equal(config.autoDreamEnabled, false);
  assert.equal(config.tools, true);
  assert.equal(config.commands, true);
  assert.equal(config.ui, true);
  assert.equal(config.subagentMemory, 'off', 'invalid subagentMemory falls back to off');
  assert.equal(config.dreamAllowDelete, true, 'v11 flips dreamAllowDelete on by default');
  assert.equal(config.indexMaxLines, 200);
  assert.equal(config.indexMaxBytes, 25 * 1024);
  assert.equal(config.minHours, 24);
  assert.equal(config.minSessions, 5);
  assert.equal(config.scanThrottleMs, 600_000);
  assert.equal(config.lockTtlMs, 3_600_000);
  assert.equal(config.dreamInputMaxChars, 96_000);
  assert.equal(config.dreamMaxFileChars, 100_000);
  assert.equal(config.dreamMaxToolChars, 4_000);
  assert.equal(config.contextOrder, 850);
  assert.equal(config.maxContentBytes, 128 * 1024);
  assert.equal(config.dreamAnalyzerMaxTokens, 8192);
  assert.equal(config.rulesMaxChars, 8000);
  assert.equal(config.memoryRoot, '');
  assert.equal(config.dreamAnalyzerProvider, '');
  assert.equal(config.dreamAnalyzerModel, '');
});

test('numeric fields are clamped into sane ranges and truncated to integers', async () => {
  const { resolveConfig } = await configModule();
  const low = resolveConfig({
    indexMaxLines: -5,
    indexMaxBytes: -1,
    minHours: -10,
    minSessions: 0,
    scanThrottleMs: 10,
    lockTtlMs: 1000,
    dreamInputMaxChars: 10,
    dreamMaxFileChars: 10,
    contextOrder: -1,
    maxContentBytes: 1,
    dreamAnalyzerMaxTokens: 1,
  });
  const lowerBounds = {
    indexMaxLines: 1,
    indexMaxBytes: 256,
    minHours: 0,
    minSessions: 1,
    scanThrottleMs: 1000,
    lockTtlMs: 60_000,
    dreamInputMaxChars: 4096,
    dreamMaxFileChars: 1000,
    contextOrder: 0,
    maxContentBytes: 1024,
    dreamAnalyzerMaxTokens: 512,
  };
  for (const [key, min] of Object.entries(lowerBounds)) {
    assert.equal(Number.isInteger(low[key]), true, `${key} must be an integer after clamping`);
    assert.ok(low[key] >= min, `${key} must be clamped up to at least ${min}, got ${low[key]}`);
  }

  const high = resolveConfig({
    indexMaxLines: 1_000_000,
    dreamMaxFileChars: 9_999_999,
  });
  assert.ok(high.indexMaxLines <= 100_000, 'indexMaxLines must be clamped down');
  assert.ok(high.dreamMaxFileChars <= 500_000, 'dreamMaxFileChars must be clamped down');

  const fractional = resolveConfig({ indexMaxLines: 12.9 });
  assert.equal(fractional.indexMaxLines, 12, 'indexMaxLines truncates to integer');
});

test('dreamAnalyzerProvider and dreamAnalyzerModel only take effect as a pair', async () => {
  const { resolveConfig } = await configModule();
  const providerOnly = resolveConfig({ dreamAnalyzerProvider: 'local', dreamAnalyzerModel: '' });
  assert.equal(providerOnly.dreamAnalyzerProvider, '');
  assert.equal(providerOnly.dreamAnalyzerModel, '');

  const modelOnly = resolveConfig({ dreamAnalyzerProvider: '', dreamAnalyzerModel: 'small' });
  assert.equal(modelOnly.dreamAnalyzerProvider, '');
  assert.equal(modelOnly.dreamAnalyzerModel, '');

  const pair = resolveConfig({ dreamAnalyzerProvider: '  local  ', dreamAnalyzerModel: '  small  ' });
  assert.equal(pair.dreamAnalyzerProvider, 'local', 'dreamAnalyzerProvider is trimmed');
  assert.equal(pair.dreamAnalyzerModel, 'small', 'dreamAnalyzerModel is trimmed');
});

test('memoryRoot is trimmed', async () => {
  const { resolveConfig } = await configModule();
  assert.equal(resolveConfig({ memoryRoot: '  ~/mem  ' }).memoryRoot, '~/mem');
});

test('subagentMemory accepts only documented values', async () => {
  const { resolveConfig } = await configModule();
  assert.equal(resolveConfig().subagentMemory, 'off', 'subagents are isolated by default');
  assert.equal(resolveConfig({ subagentMemory: 'shared' }).subagentMemory, 'shared');
  assert.equal(resolveConfig({ subagentMemory: 'own' }).subagentMemory, 'own');
  assert.equal(resolveConfig({ subagentMemory: 'sometimes' }).subagentMemory, 'off', 'invalid mode falls back to off');
});

test('recallMode is model or off, with no legacy boolean', async () => {
  const { resolveConfig } = await configModule();
  assert.equal(resolveConfig().recallMode, 'model', 'new configs get the per-turn selector');
  assert.equal(resolveConfig({ recallMode: 'lexical' }).recallMode, 'model', 'lexical is gone and falls back to model');
  assert.equal(resolveConfig({ recallMode: 'bogus' }).recallMode, 'model', 'unknown mode falls back to model');
  assert.equal(resolveConfig({ recallMode: 'off' }).recallMode, 'off');
  assert.equal(resolveConfig({ autoRecall: false }).recallMode, 'model', 'the old boolean is ignored');
  assert.equal(Object.prototype.hasOwnProperty.call(resolveConfig(), 'autoRecall'), false, 'autoRecall is not exposed');
});

test('CLAUDE_CODE_DISABLE_AUTO_MEMORY turns recall off whatever the config says', async () => {
  const { resolveConfig } = await configModule();
  const config = resolveConfig({ recallMode: 'model' }, { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  assert.equal(config.autoMemoryEnabled, false);
  assert.equal(config.recallMode, 'off');
});

test('autoExtract and subagent memory are opt-in', async () => {
  const { resolveConfig } = await configModule();
  const config = resolveConfig();
  assert.equal(config.autoExtract, false);
  assert.equal(config.autoExtractEveryTurns, 3);
  assert.equal(config.subagentMemory, 'off');
  assert.deepEqual(config.agentMemoryPresets, []);
  const custom = resolveConfig({
    autoExtract: true,
    autoExtractEveryTurns: 5,
    subagentMemory: 'own',
    agentMemoryPresets: [' reviewer ', '', 7],
  });
  assert.equal(custom.autoExtract, true);
  assert.equal(custom.autoExtractEveryTurns, 5);
  assert.equal(custom.subagentMemory, 'own');
  assert.deepEqual(custom.agentMemoryPresets, ['reviewer']);
});

test('legacy Dream model settings normalize to one analyzer pair', async () => {
  const { resolveConfig } = await configModule();
  const legacy = { dreamProvider: 'old-provider', dreamModel: 'old-model' };
  const migrated = resolveConfig({ ...legacy, dreamAnalyzerProvider: 'partial' });
  assert.equal(migrated.dreamAnalyzerProvider, 'old-provider');
  assert.equal(migrated.dreamAnalyzerModel, 'old-model');
  assert.equal(Object.hasOwn(migrated, 'dreamProvider'), false);
  assert.equal(Object.hasOwn(migrated, 'dreamModel'), false);
  assert.equal(Object.hasOwn(migrated, 'llmMaxTokens'), false);

  const current = resolveConfig({
    ...legacy,
    dreamAnalyzerProvider: 'current-provider',
    dreamAnalyzerModel: 'current-model',
  });
  assert.equal(current.dreamAnalyzerProvider, 'current-provider');
  assert.equal(current.dreamAnalyzerModel, 'current-model');
});
