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

/** Values documented in INTERFACES.md (Lead added refreshIntervalMs later). */
const DOCUMENTED_DEFAULTS = {
  enabled: true,
  autoMemoryEnabled: true,
  memoryRoot: '',
  userMemoryEnabled: false,
  injectIndex: true,
  injectionMode: 'session',
  indexMaxLines: 200,
  indexMaxBytes: 25 * 1024,
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
  dreamMaxToolChars: 4_000,
  sessionLookback: 8,
  tools: true,
  commands: true,
  ui: true,
  injectSubagents: false,
  contextOrder: 850,
  maxContentBytes: 128 * 1024,
  llmMaxTokens: 16_384,
  rulesMaxChars: 8000,
  refreshIntervalMs: 30_000,
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
    userMemoryEnabled: true,
    injectIndex: false,
    injectionMode: 'live',
    indexMaxLines: 120,
    indexMaxBytes: 4096,
    autoDreamEnabled: true,
    minHours: 2,
    minSessions: 2,
    scanThrottleMs: 5000,
    lockTtlMs: 60_000,
    dreamMode: 'review',
    dreamProvider: 'local',
    dreamModel: 'small-model',
    dreamAllowDelete: true,
    dreamMaxOps: 7,
    dreamInputMaxChars: 10_000,
    dreamMaxFileChars: 15_000,
    dreamMaxSessionChars: 5000,
    sessionLookback: 3,
    tools: false,
    commands: false,
    ui: false,
    injectSubagents: false,
    contextOrder: 100,
    maxContentBytes: 2048,
    llmMaxTokens: 1024,
    rulesMaxChars: 4000,
    refreshIntervalMs: 10_000,
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
    userMemoryEnabled: 1,
    injectIndex: null,
    injectionMode: 'sometimes',
    autoDreamEnabled: 'on',
    tools: 0,
    commands: '',
    ui: null,
    injectSubagents: 'yes',
    dreamAllowDelete: 'yes',
    indexMaxLines: 'many',
    indexMaxBytes: {},
    minHours: null,
    minSessions: Number.NaN,
    scanThrottleMs: undefined,
    lockTtlMs: Number.NaN,
    dreamMaxOps: 'several',
    dreamInputMaxChars: null,
    dreamMaxFileChars: 'lots',
    dreamMaxSessionChars: {},
    sessionLookback: {},
    contextOrder: null,
    maxContentBytes: 'huge',
    llmMaxTokens: [],
    rulesMaxChars: [],
    refreshIntervalMs: null,
    memoryRoot: 42,
    dreamMode: 'sometimes',
    dreamProvider: 7,
    dreamModel: null,
  });
  assert.equal(config.enabled, true, 'enabled (invalid string) falls back to default true');
  assert.equal(config.autoMemoryEnabled, true, 'autoMemoryEnabled (invalid string) falls back to default true');
  assert.equal(config.userMemoryEnabled, false);
  assert.equal(config.injectIndex, true);
  assert.equal(config.injectionMode, 'session', 'invalid injectionMode falls back to session');
  assert.equal(config.autoDreamEnabled, false);
  assert.equal(config.tools, true);
  assert.equal(config.commands, true);
  assert.equal(config.ui, true);
  assert.equal(config.injectSubagents, false, 'invalid injectSubagents falls back to false');
  assert.equal(config.dreamAllowDelete, true, 'v11 flips dreamAllowDelete on by default');
  assert.equal(config.indexMaxLines, 200);
  assert.equal(config.indexMaxBytes, 25 * 1024);
  assert.equal(config.minHours, 24);
  assert.equal(config.minSessions, 5);
  assert.equal(config.scanThrottleMs, 600_000);
  assert.equal(config.lockTtlMs, 3_600_000);
  assert.equal(config.dreamMaxOps, 40);
  assert.equal(config.dreamInputMaxChars, 96_000);
  assert.equal(config.dreamMaxFileChars, 20_000);
  assert.equal(config.dreamMaxSessionChars, 12_000);
  assert.equal(config.dreamMaxToolChars, 4_000);
  assert.equal(config.sessionLookback, 8);
  assert.equal(config.contextOrder, 850);
  assert.equal(config.maxContentBytes, 128 * 1024);
  assert.equal(config.llmMaxTokens, 16_384);
  assert.equal(config.rulesMaxChars, 8000);
  assert.equal(config.refreshIntervalMs, 30_000);
  assert.equal(config.memoryRoot, '');
  assert.equal(config.dreamMode, 'apply', 'invalid dreamMode falls back to apply');
  assert.equal(config.dreamProvider, '');
  assert.equal(config.dreamModel, '');
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
    dreamMaxOps: 0,
    dreamInputMaxChars: 10,
    dreamMaxFileChars: 10,
    dreamMaxSessionChars: 10,
    sessionLookback: -3,
    contextOrder: -1,
    maxContentBytes: 1,
    llmMaxTokens: 1,
    refreshIntervalMs: 1,
  });
  const lowerBounds = {
    indexMaxLines: 1,
    indexMaxBytes: 256,
    minHours: 0,
    minSessions: 1,
    scanThrottleMs: 1000,
    lockTtlMs: 60_000,
    dreamMaxOps: 1,
    dreamInputMaxChars: 4096,
    dreamMaxFileChars: 1000,
    dreamMaxSessionChars: 800,
    sessionLookback: 0,
    contextOrder: 0,
    maxContentBytes: 1024,
    llmMaxTokens: 256,
    refreshIntervalMs: 5000,
  };
  for (const [key, min] of Object.entries(lowerBounds)) {
    assert.equal(Number.isInteger(low[key]), true, `${key} must be an integer after clamping`);
    assert.ok(low[key] >= min, `${key} must be clamped up to at least ${min}, got ${low[key]}`);
  }

  const high = resolveConfig({
    indexMaxLines: 1_000_000,
    dreamMaxOps: 99_999,
    sessionLookback: 99_999,
    dreamMaxFileChars: 9_999_999,
    dreamMaxSessionChars: 9_999_999,
  });
  assert.ok(high.indexMaxLines <= 100_000, 'indexMaxLines must be clamped down');
  assert.ok(high.dreamMaxOps <= 500, 'dreamMaxOps must be clamped down');
  assert.ok(high.sessionLookback <= 100, 'sessionLookback must be clamped down');
  assert.ok(high.dreamMaxFileChars <= 500_000, 'dreamMaxFileChars must be clamped down');
  assert.ok(high.dreamMaxSessionChars <= 100_000, 'dreamMaxSessionChars must be clamped down');

  const fractional = resolveConfig({ indexMaxLines: 12.9, dreamMaxOps: 5.8 });
  assert.equal(fractional.indexMaxLines, 12, 'indexMaxLines truncates to integer');
  assert.equal(fractional.dreamMaxOps, 5, 'dreamMaxOps truncates to integer');
});

test('dreamProvider and dreamModel only take effect as a pair', async () => {
  const { resolveConfig } = await configModule();
  const providerOnly = resolveConfig({ dreamProvider: 'local', dreamModel: '' });
  assert.equal(providerOnly.dreamProvider, '');
  assert.equal(providerOnly.dreamModel, '');

  const modelOnly = resolveConfig({ dreamProvider: '', dreamModel: 'small' });
  assert.equal(modelOnly.dreamProvider, '');
  assert.equal(modelOnly.dreamModel, '');

  const pair = resolveConfig({ dreamProvider: '  local  ', dreamModel: '  small  ' });
  assert.equal(pair.dreamProvider, 'local', 'dreamProvider is trimmed');
  assert.equal(pair.dreamModel, 'small', 'dreamModel is trimmed');
});

test('memoryRoot is trimmed', async () => {
  const { resolveConfig } = await configModule();
  assert.equal(resolveConfig({ memoryRoot: '  ~/mem  ' }).memoryRoot, '~/mem');
});

test('injectionMode and injectSubagents accept only documented values', async () => {
  const { resolveConfig } = await configModule();
  assert.equal(resolveConfig().injectionMode, 'session', 'injection defaults to frozen session mode');
  assert.equal(resolveConfig({ injectionMode: 'live' }).injectionMode, 'live');
  assert.equal(resolveConfig({ injectionMode: 'LIVE' }).injectionMode, 'session', 'injectionMode is case-sensitive');
  assert.equal(resolveConfig({ injectionMode: 'always' }).injectionMode, 'session', 'unknown mode falls back to session');

  assert.equal(resolveConfig().injectSubagents, false, 'subagent sessions are not injected by default');
  assert.equal(resolveConfig({ injectSubagents: false }).injectSubagents, false);
  assert.equal(resolveConfig({ injectSubagents: 'no' }).injectSubagents, false, 'invalid flag falls back to false');
});
