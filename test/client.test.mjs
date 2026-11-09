/**
 * Client bundle tests (v7 §6): load the REAL `client.js` through `node:vm` with a
 * fake `window.__ModuleLoader__` and a tiny React shim, then test the parts that
 * are reachable without a DOM:
 *
 *   - the factory contract (`id`, `inject`, `apply`) and locale registration;
 *   - locale/en.json + locale/zh.json key parity with the inline dictionaries;
 *   - `createBackend` via the slot injection: bridge-missing fallback to slash
 *     commands, no-backend, and the silent-API path with a fake `fetch`
 *     (status/file normalization, 401 token-expired classification);
 *   - the pure helpers exposed on `window.__CC_MEMORY_INTERNALS__`
 *     (normalizeStatus/normalizeFile/renderMarkdown/renderInline/
 *     resolveApiConfig/createBackend/apiRequest).
 *
 * The internals hook is a v7 contract item owned by ui-commands; until it lands
 * the dependent assertions are reported as skipped with a "[waiting]" reason so
 * the rest of the suite stays green, and they activate automatically after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { PLUGIN_ROOT } from './helpers.mjs';

// ---------------------------------------------------------------------------
// VM harness
// ---------------------------------------------------------------------------

/** Minimal React shim: hooks are inert, createElement builds inspectable nodes. */
function createReactShim() {
  const makeNode = (type, props, children) => ({
    type,
    props: { ...(props || {}) },
    children: children.flat(Infinity),
  });
  class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next || {}) };
    }
    forceUpdate() {}
    render() {
      return null;
    }
  }
  return {
    Fragment: 'Fragment',
    Component,
    PureComponent: Component,
    createElement(type, props, ...children) {
      return makeNode(type, props, children);
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      return { current: initial };
    },
    memo(component) {
      return component;
    },
  };
}

/**
 * Create a vm sandbox that emulates the browser surface client.js touches:
 * `window.__ModuleLoader__`, `window.location`, an optional `__CC_MEMORY_API__`
 * bridge, `fetch`, timers and a quiet console.
 */
function createSandbox({ apiBridge, fetchImpl } = {}) {
  const loaderCalls = [];
  const fetchCalls = [];
  const windowObject = {
    __ModuleLoader__: {
      load(config) {
        loaderCalls.push(config);
      },
    },
    location: {
      reload() {},
    },
  };
  if (apiBridge !== undefined) windowObject.__CC_MEMORY_API__ = apiBridge;
  const sandbox = {
    window: windowObject,
    console: {
      log() {},
      warn() {},
      error() {},
      info() {},
      debug() {},
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (...args) => {
      fetchCalls.push(args);
      if (typeof fetchImpl === 'function') return fetchImpl(...args);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  };
  const context = vm.createContext(sandbox);
  return { context, sandbox, windowObject, loaderCalls, fetchCalls };
}

let clientSourcePromise;

function clientSource() {
  if (!clientSourcePromise) clientSourcePromise = readFile(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  return clientSourcePromise;
}

/** Load client.js in a fresh vm and execute the ModuleLoader factory. */
async function loadClient(options = {}) {
  const source = await clientSource();
  const harness = createSandbox(options);
  new vm.Script(source, { filename: 'client.js' }).runInContext(harness.context);
  assert.equal(harness.loaderCalls.length, 1, 'client.js must call window.__ModuleLoader__.load exactly once');
  const config = harness.loaderCalls[0];
  assert.equal(config.id, 'dsh-cc-dream-memory', 'ModuleLoader id must be dsh-cc-dream-memory');
  assert.equal(typeof config.factory, 'function', 'ModuleLoader entry must expose a factory');

  const react = createReactShim();
  const requireCalls = [];
  const plugin = config.factory((name) => {
    requireCalls.push(name);
    if (name !== 'react') throw new Error(`client.js must only require react, got ${name}`);
    return react;
  });
  assert.deepEqual(requireCalls, ['react'], 'client.js may require react only');
  assert.ok(plugin && typeof plugin === 'object', 'factory must return the plugin object');
  return { ...harness, config, react, plugin };
}

/**
 * Apply the plugin against a fake client ctx and capture everything it
 * registers (locale dictionaries, slot definitions).
 */
async function mountClient(client, { localeActive = 'en', commandExecute } = {}) {
  const dictionaries = [];
  const slotDefinitions = [];
  const effects = [];
  const ctx = {
    effect(factory) {
      const dispose = factory();
      effects.push(dispose);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
      getLocale() {
        return { active: localeActive };
      },
    },
    slots: {
      inject(name, factory) {
        factory();
      },
      register(definition) {
        slotDefinitions.push(definition);
        return () => {};
      },
    },
    remote: commandExecute
      ? {
          commands: {
            execute: commandExecute,
          },
        }
      : {},
  };
  const applied = client.plugin.apply(ctx);
  if (applied && typeof applied.then === 'function') await applied;
  return { ctx, dictionaries, slotDefinitions, effects };
}

function findDefinition(definitions, name) {
  return definitions.find((definition) => definition.name === name);
}

/** Unwrap a rendered node list (renderMarkdown may return one node). */
function toNodeArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function collectTypes(nodes, out = []) {
  for (const node of toNodeArray(nodes)) {
    if (!node || typeof node !== 'object') continue;
    out.push(String(node.type));
    collectTypes(node.children, out);
  }
  return out;
}

function collectText(nodes) {
  let text = '';
  for (const node of toNodeArray(nodes)) {
    if (typeof node === 'string' || typeof node === 'number') {
      text += String(node);
      continue;
    }
    if (node && typeof node === 'object') text += collectText(node.children);
  }
  return text;
}

function findNode(nodes, predicate) {
  for (const node of toNodeArray(nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (predicate(node)) return node;
    const nested = findNode(node.children, predicate);
    if (nested) return nested;
  }
  return undefined;
}

/** The v7 internals hook; skip with a clear reason while ui-commands hasn't landed it. */
function internalsOrSkip(t, client) {
  const hook = client.windowObject.__CC_MEMORY_INTERNALS__;
  if (!hook || typeof hook !== 'object') {
    t.skip('[waiting] window.__CC_MEMORY_INTERNALS__ is not exposed by client.js yet (v7 contract §5, ui-commands)');
    return null;
  }
  return hook;
}

const REQUIRED_INTERNALS = ['normalizeStatus', 'normalizeFile', 'createBackend', 'renderMarkdown', 'renderInline'];

// ---------------------------------------------------------------------------
// Harness / factory contract
// ---------------------------------------------------------------------------

test('client: real client.js loads through ModuleLoader and returns the plugin contract', async () => {
  const client = await loadClient();
  assert.equal(client.config.id, 'dsh-cc-dream-memory');
  assert.deepEqual([...client.plugin.inject], ['slots', 'locale', 'remote', 'remote.commands']);
  assert.equal(typeof client.plugin.apply, 'function');
  assert.equal(typeof client.windowObject.__CC_MEMORY_API__, 'undefined');
});

test('client: client.js has no `\\*` escapes (the Host snapshot drops the backslash in `\\*\\*`)', async () => {
  // 2026-11-07: a cold boot served `/(**[^*]+**|...)/g` and the whole app refused to start.
  const source = await readFile(path.join(PLUGIN_ROOT, 'client.js'), 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.equal(code.includes('\\*'), false, 'use [*] instead of \\* in client.js regexes');
});

test('client: registers the locale dictionaries and en/zh key sets match locale JSON', async () => {
  const client = await loadClient();
  const { dictionaries } = await mountClient(client);
  assert.equal(dictionaries.length, 1, 'apply must register exactly one locale namespace');
  const [{ namespace, dicts }] = dictionaries;
  assert.equal(namespace, 'dsh-cc-dream-memory', 'locale namespace must match the plugin id');
  assert.ok(dicts && typeof dicts === 'object', 'locale.register must receive the dictionaries');
  assert.ok(dicts.en && typeof dicts.en === 'object', 'English inline dictionary is missing');
  assert.ok(dicts.zh && typeof dicts.zh === 'object', 'Chinese inline dictionary is missing');

  const enJson = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'locale', 'en.json'), 'utf8'));
  const zhJson = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'locale', 'zh.json'), 'utf8'));
  const inlineEnKeys = Object.keys(dicts.en).sort();
  const inlineZhKeys = Object.keys(dicts.zh).sort();
  const jsonEnKeys = Object.keys(enJson)
    .filter((key) => key !== 'meta')
    .sort();
  const jsonZhKeys = Object.keys(zhJson)
    .filter((key) => key !== 'meta')
    .sort();

  assert.equal(inlineEnKeys.length >= 90, true, `expected 90+ English keys, got ${inlineEnKeys.length}`);
  assert.deepEqual(inlineEnKeys, inlineZhKeys, 'inline en/zh dictionaries must expose the same keys');
  assert.deepEqual(inlineEnKeys, jsonEnKeys, 'locale/en.json keys must match the inline English dictionary');
  assert.deepEqual(inlineZhKeys, jsonZhKeys, 'locale/zh.json keys must match the inline Chinese dictionary');
  for (const key of inlineEnKeys) {
    assert.equal(typeof dicts.en[key], 'string', `inline en[${key}] must be a string`);
    assert.equal(typeof dicts.zh[key], 'string', `inline zh[${key}] must be a string`);
  }
});

// ---------------------------------------------------------------------------
// Backend branches reachable through the slot injection
// ---------------------------------------------------------------------------

function makeStatusPayload(overrides = {}) {
  return {
    ok: true,
    version: '0.5.0',
    config: { enabled: true, autoMemoryEnabled: false, autoDreamEnabled: true, dreamMode: 'review', indexMaxLines: 100 },
    overrides: { enabled: false },
    index: { text: '- [a](a.md) — note', lines: 1, bytes: 18, truncated: false, overflow: false },
    entries: [
      { file: 'a.md', name: 'a', description: 'note', type: 'user', bytes: 10, lines: 1 },
      { junk: true },
    ],
    userScope: { enabled: false, entries: [] },
    state: {
      lastDreamAt: 1234,
      lastDreamAttemptAt: 1200,
      lastDreamSummary: 'merged',
      lastDreamSessions: 3,
      lastDreamOps: 2,
      lastDreamMode: 'apply',
      lastPlanPath: '/tmp/plan.json',
      pendingProposal: '',
      lastError: '',
      consecutiveFailures: 0,
      counters: { dreams: 1 },
      sessionsSince: [{ id: 's1' }, { id: 's2' }],
    },
    changelogTail: '## tail',
    trashCount: 2,
    rules: { text: '- RULE', source: 'project', projectPath: '/p/rules.md', globalPath: '/g/rules.md', maxChars: 8000 },
    health: { ok: true, warnings: [], services: {} },
    ...overrides,
  };
}

test('client: createBackend falls back to commands (bridge-missing) or none (no backend)', async () => {
  const client = await loadClient();
  const executeCalls = [];
  const statusPayload = makeStatusPayload();
  const { slotDefinitions } = await mountClient(client, {
    localeActive: 'en',
    commandExecute: async (sessionId, line) => {
      executeCalls.push({ sessionId, line });
      if (line.includes('/memory json')) {
        return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(statusPayload) } } };
      }
      return { ok: true, value: { result: { kind: 'success', text: 'file body from command' } } };
    },
  });

  const view = findDefinition(slotDefinitions, 'conversation.view');
  assert.ok(view, 'conversation.view must be registered');
  assert.equal(view.id, 'cc-memory');
  assert.equal(view.order, 40);
  const viewProps = view.inject({ sessionId: 'session-1' });
  assert.ok(viewProps.memBackend, 'view inject must provide a backend');
  assert.equal(viewProps.memBackend.mode, 'commands', 'without the API bridge the backend degrades to commands');
  assert.equal(viewProps.memBackend.reason, 'bridge-missing');

  const normalized = await viewProps.memBackend.status();
  assert.equal(normalized.degraded, true, 'command fallback payload is marked degraded');
  assert.equal(normalized.config.autoDreamEnabled, true);
  assert.equal(normalized.config.dreamMode, 'review');
  assert.equal(normalized.entries.length, 1, 'invalid entries are filtered from the fallback payload');
  assert.equal(normalized.state.sessionsSince, 2, 'session arrays are normalized to a count');
  assert.equal(normalized.trashCount, 2);
  assert.equal(normalized.rules.source, 'project');
  assert.equal(executeCalls[0].line, '/memory json');
  assert.equal(executeCalls[0].sessionId, 'session-1');

  const file = await viewProps.memBackend.file('a.md', 'project');
  assert.equal(file.file, 'a.md');
  assert.match(file.body, /file body from command/);
  assert.equal(file.frontmatter, null);

  // A chip without a session id has neither API nor commands => no backend.
  const chip = findDefinition(slotDefinitions, 'conversation.composer.dock');
  assert.ok(chip, 'conversation.composer.dock must be registered');
  assert.equal(chip.id, 'cc-memory-status');
  assert.equal(chip.order, 50);
  const chipProps = chip.inject({});
  assert.equal(chipProps.memBackend.mode, 'none');
  assert.equal(chipProps.memBackend.reason, 'no-backend');
});

test('client v4: recovers the API bridge from /api/cc-memory/bridge when the global is missing', async () => {
  const bridgeCalls = [];
  const client = await loadClient({
    fetchImpl: async (url, options) => {
      bridgeCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, base: '/api/cc-memory', token: 'tok-bridge' }) };
    },
  });
  const { slotDefinitions } = await mountClient(client);
  assert.equal(bridgeCalls[0].url, '/api/cc-memory/bridge', 'the bridge endpoint is fetched relative to the page origin');
  const view = findDefinition(slotDefinitions, 'conversation.view');
  const props = view.inject({ sessionId: 'session-bridge' });
  assert.equal(props.memBackend.mode, 'api', 'the discovered bridge restores API mode (no read-only banner)');
  assert.equal(props.memBackend.reason, null);
});

test('client: silent API backend normalizes /status + /file and classifies 401 as token-expired', async () => {
  const statusPayload = makeStatusPayload();
  const filePayload = {
    ok: true,
    file: 'a.md',
    scope: 'project',
    frontmatter: { name: 'a', type: 'user' },
    body: '**markdown** body',
    raw: '---\nname: a\n---\n\n**markdown** body',
  };
  let mode = 'ok';
  const client = await loadClient({
    apiBridge: { base: 'http://127.0.0.1:61145/api/cc-memory/', token: 'tok-123' },
    fetchImpl: async (url, options) => {
      if (mode === '401') {
        return { ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized', message: 'bad token' }) };
      }
      if (String(url).includes('/file')) {
        return { ok: true, status: 200, json: async () => filePayload };
      }
      return { ok: true, status: 200, json: async () => statusPayload };
    },
  });
  const { slotDefinitions } = await mountClient(client);
  const view = findDefinition(slotDefinitions, 'conversation.view');
  const props = view.inject({ sessionId: 'session-9' });
  assert.equal(props.memBackend.mode, 'api');
  assert.equal(props.memBackend.reason, null);

  const status = await props.memBackend.status();
  assert.equal(status.degraded, false);
  assert.equal(status.config.autoMemoryEnabled, false, 'API booleans are preserved');
  assert.equal(status.index.lines, 1);
  assert.equal(status.entries.length, 1, 'invalid entries are filtered');
  assert.equal(status.state.lastDreamSummary, 'merged');
  assert.equal(status.rules.maxChars, 8000);

  const [url, options] = client.fetchCalls.at(-1);
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:61145\/api\/cc-memory\/status\?sessionId=session-9$/);
  assert.equal(options.headers['x-cc-memory-token'], 'tok-123', 'requests must carry the injected token');

  const file = await props.memBackend.file('a.md', 'project');
  assert.equal(file.raw, filePayload.raw);
  assert.equal(file.frontmatter.name, 'a');
  assert.match(file.body, /\*\*markdown\*\* body/);

  // A rotated/expired token surfaces a classified "401 unauthorized" error.
  mode = '401';
  await assert.rejects(props.memBackend.status(), (error) => {
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.status, 401);
    assert.match(String(error.message), /401|unauthorized|token/i, 'UI token-expired classifier must match this error');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Pure helpers exposed through window.__CC_MEMORY_INTERNALS__
// ---------------------------------------------------------------------------

test('client: exposes window.__CC_MEMORY_INTERNALS__ with the documented pure helpers', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  for (const name of REQUIRED_INTERNALS) {
    assert.equal(typeof internals[name], 'function', `__CC_MEMORY_INTERNALS__.${name} must be a function`);
  }
  const apiConfigFn = internals.resolveApiConfig ?? internals.readApiConfig;
  assert.equal(typeof apiConfigFn, 'function', 'resolveApiConfig (or readApiConfig) must be exported');
  assert.equal(typeof internals.apiRequest, 'function', 'apiRequest must be exported');
});

test('client: normalizeStatus fills safe defaults and filters malformed entries', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const empty = internals.normalizeStatus(null);
  assert.equal(Object.keys(empty.project).length, 0, 'missing project normalizes to an empty object');
  assert.equal(empty.config.enabled, true);
  assert.equal(empty.config.autoMemoryEnabled, true);
  assert.equal(empty.config.autoDreamEnabled, false);
  assert.equal(empty.config.dreamMode, 'apply');
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.index.text, '');
  assert.equal(empty.state.lastDreamAt, 0);
  assert.equal(empty.state.sessionsSince, 0);
  assert.equal(empty.rules.source, 'default');
  assert.equal(empty.degraded, false);
  assert.equal(empty.userScope.enabled, false);
  assert.equal(empty.userScope.entries.length, 0);

  const filled = internals.normalizeStatus(makeStatusPayload());
  assert.equal(filled.entries.length, 1);
  assert.equal(filled.entries[0].file, 'a.md');
  assert.equal(filled.state.sessionsSince, 2);
  assert.equal(filled.rules.source, 'project');
  assert.equal(filled.userScope.enabled, false);
});

test('client: normalizeFile defaults the body to raw, scope to project and provenance to empty', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const empty = internals.normalizeFile(null);
  assert.equal(empty.file, '');
  assert.equal(empty.scope, 'project');
  assert.equal(empty.frontmatter, null);
  assert.equal(empty.body, '');
  assert.equal(empty.raw, '');
  // v7 provenance defaults (old files without the optional frontmatter fields).
  assert.equal(empty.via, '');
  assert.equal(empty.sourceSession, '');
  assert.equal(empty.created, '');

  const fromRaw = internals.normalizeFile({ file: 'a.md', raw: 'raw body' });
  assert.equal(fromRaw.body, 'raw body', 'body falls back to raw when absent');
  assert.equal(fromRaw.scope, 'project');

  const userScope = internals.normalizeFile({ file: 'u.md', scope: 'user', frontmatter: { name: 'u' }, body: 'body' });
  assert.equal(userScope.scope, 'user');
  assert.equal(userScope.frontmatter.name, 'u');
});

test('client: renderInline renders bold/em/code/links as React nodes', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const nodes = internals.renderInline('**bold** and *em* and `code` and [link](https://example.com)');
  const types = collectTypes(nodes);
  for (const expected of ['strong', 'em', 'code', 'a']) {
    assert.equal(types.includes(expected), true, `renderInline must render <${expected}> (types: ${types.join(',')})`);
  }
  const link = findNode(nodes, (node) => node.type === 'a');
  assert.equal(link.props.href, 'https://example.com');
  assert.equal(link.props.rel, 'noreferrer noopener');
  assert.equal(collectText(nodes), 'bold and em and code and link');
});

test('client: renderMarkdown renders headings, lists, bold, links and fenced code', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const nodes = internals.renderMarkdown(
    [
      '## Title',
      '',
      '- **bold** first',
      '- second item',
      '',
      'A [link](https://example.com) in a paragraph.',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '> quoted',
      '',
      '1. ordered one',
      '2. ordered two',
      '',
      '---',
    ].join('\n'),
  );
  const types = collectTypes(nodes);
  const heading = findNode(nodes, (node) => /^h[1-6]$/.test(String(node.type)));
  assert.ok(heading, `renderMarkdown must render a heading (types: ${types.join(',')})`);
  assert.match(String(heading.type), /^h[1-6]$/);
  assert.match(collectText(heading), /Title/);

  const list = findNode(nodes, (node) => node.type === 'ul');
  assert.ok(list, 'renderMarkdown must render unordered lists');
  assert.equal(list.children.filter((child) => child && child.type === 'li').length, 2);
  assert.equal(types.includes('strong'), true, 'bold text inside a list item must render');
  assert.equal(types.includes('a'), true, 'links must render');
  const link = findNode(nodes, (node) => node.type === 'a');
  assert.equal(link.props.href, 'https://example.com');

  assert.equal(types.includes('pre'), true, 'fenced code blocks must render');
  assert.equal(types.includes('blockquote'), true, 'blockquotes must render');
  assert.equal(types.includes('ol'), true, 'ordered lists must render');
  assert.equal(types.includes('hr'), true, 'horizontal rules must render');
});

test('client: resolveApiConfig trims the base and rejects incomplete bridges', async (t) => {
  const withBridge = await loadClient({ apiBridge: { base: '/api/cc-memory/', token: 'tok' } });
  const internals = internalsOrSkip(t, withBridge);
  if (!internals) return;
  const resolve = internals.resolveApiConfig ?? internals.readApiConfig;
  const resolved = resolve();
  assert.ok(resolved, 'a complete bridge must resolve');
  assert.equal(resolved.base, '/api/cc-memory');
  assert.equal(resolved.token, 'tok');

  withBridge.windowObject.__CC_MEMORY_API__ = { base: '', token: 'tok' };
  assert.equal(resolve(), null, 'an empty base must not resolve');

  const withoutBridge = await loadClient();
  const noBridgeInternals = internalsOrSkip(t, withoutBridge);
  if (!noBridgeInternals) return;
  const resolveEmpty = noBridgeInternals.resolveApiConfig ?? noBridgeInternals.readApiConfig;
  assert.equal(resolveEmpty(), null, 'no bridge resolves to null');
});

test('client: createBackend exposes mode/reason without a DOM', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const apiBackend = internals.createBackend({ api: { base: '/x', token: '' }, commandRunner: null, sessionId: 's1' });
  assert.equal(apiBackend.mode, 'api');
  assert.equal(apiBackend.reason, null);

  const commandRunner = async () => '';
  const commandsBackend = internals.createBackend({ api: null, commandRunner, sessionId: 's1' });
  assert.equal(commandsBackend.mode, 'commands');
  assert.equal(commandsBackend.reason, 'bridge-missing');

  const noneBackend = internals.createBackend({ api: null, commandRunner: null, sessionId: undefined });
  assert.equal(noneBackend.mode, 'none');
  assert.equal(noneBackend.reason, 'no-backend');
});

// ---------------------------------------------------------------------------
// v8: normalizeMetrics hook
// ---------------------------------------------------------------------------

/** Accept both status-metrics (`inject`) and raw-metrics (`injections`) shapes. */
function metricNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

test('client: __CC_MEMORY_INTERNALS__ exposes normalizeMetrics with safe defaults', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  if (typeof internals.normalizeMetrics !== 'function') {
    t.skip('[waiting] normalizeMetrics is not exposed by client.js yet (v8 contract §4, ui-commands)');
    return;
  }

  const empty = internals.normalizeMetrics(null);
  assert.equal(typeof empty, 'object');
  const inject = empty.inject ?? empty.injections;
  assert.ok(inject && typeof inject === 'object', 'normalizeMetrics must expose the injection counter block');
  assert.equal(metricNumber(inject.count), 0);
  assert.ok(empty.reads && typeof empty.reads === 'object');
  assert.equal(metricNumber(empty.reads.total), 0);
  // vm-realm arrays: compare by length/spread, not strict deepEqual.
  assert.equal(empty.reads.top.length, 0);
  assert.equal(empty.reads.neverRead.length, 0);
  assert.equal(metricNumber((empty.writes ?? {}).total), 0);
  assert.ok(empty.searches && typeof empty.searches === 'object');
  assert.equal(metricNumber(empty.searches.count), 0);
  assert.equal(metricNumber(empty.searches.hits), 0);
  assert.ok(empty.dreams && typeof empty.dreams === 'object');
  assert.equal(metricNumber(empty.dreams.acceptanceRate), 0);
  assert.equal(metricNumber(empty.dreams.appliedOps), 0);
  assert.ok(empty.costs && typeof empty.costs === 'object');
  assert.equal(metricNumber(empty.costs.lastDurationMs), 0);
  assert.equal(metricNumber(empty.updatedAt), 0);

  // Dirty values are sanitized (numbers stay finite, arrays filtered); the
  // contract does not require clamping counters to zero, only safe normalization.
  const dirty = internals.normalizeMetrics({
    injections: { count: 'bad', lastAt: 'nope' },
    inject: { count: 'bad', lastAt: 'nope' },
    reads: {
      total: 'bad',
      top: [null, 'bad', { file: 'a.md', reads: '2' }, { file: 7, reads: 1 }],
      neverRead: [7, 'b.md', null],
    },
    writes: { total: 'lots' },
    searches: { count: 'x', hits: 'y' },
    dreams: { applied: '2', rejected: 1, acceptanceRate: 'x', appliedOps: 'z' },
    costs: { lastDurationMs: 'x', lastInputChars: 'y', lastOutputChars: 'z', lastUsage: { totalTokens: 'x' } },
    updatedAt: 'nope',
  });
  const dirtyInject = dirty.inject ?? dirty.injections;
  assert.equal(Number.isFinite(dirtyInject.count), true, 'a bad counter normalizes to a finite number');
  assert.equal(metricNumber(dirtyInject.lastAt), 0, 'non-numeric timestamps normalize to 0');
  assert.equal(Number.isFinite(dirty.reads.total), true);
  assert.equal(dirty.reads.top.every((item) => item && typeof item.file === 'string'), true, 'top entries are filtered');
  assert.equal(dirty.reads.top.length, 1, 'only the well-formed top entry survives');
  assert.equal(dirty.reads.neverRead.every((file) => typeof file === 'string'), true, 'neverRead entries are filtered');
  assert.deepEqual([...dirty.reads.neverRead], ['b.md']);
  assert.equal(Number.isFinite((dirty.writes ?? {}).total), true);
  assert.equal(Number.isFinite(dirty.searches.count), true);
  assert.equal(Number.isFinite(dirty.searches.hits), true);
  assert.equal(metricNumber(dirty.dreams.acceptanceRate) >= 0, true);
  assert.equal(metricNumber(dirty.dreams.acceptanceRate) <= 1, true);
  assert.equal(Number.isFinite(dirty.dreams.appliedOps), true);
  assert.equal(metricNumber(dirty.costs.lastDurationMs), 0);
  assert.equal(metricNumber(dirty.costs.lastOutputChars), 0);
  assert.equal(metricNumber(dirty.updatedAt), 0);
});

// ---------------------------------------------------------------------------
// v9: pending writes / readiness / health / live-session surfaces
// ---------------------------------------------------------------------------

test('client: normalizeStatus carries the v9 status blocks when present', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const raw = {
    ok: true,
    config: {},
    index: { text: '', lines: 0, bytes: 0 },
    entries: [],
    userScope: { enabled: false, entries: [] },
    state: {},
    metrics: { injections: { count: 0, lastAt: 0 }, reads: { total: 0, top: [], neverRead: [] }, dreams: {} },
    pendingWrites: {
      count: 1,
      items: [{ id: 'p1', createdAt: 1, candidate: { name: 'queued note', type: 'user', description: 'd' }, reasons: ['write-mode-confirm'], source: 'tool:memory_save' }],
    },
    readiness: {
      eligible: false,
      nextEligibleAt: 123,
      reasons: [{ code: 'min-hours', message: 'wait for the time gate' }],
      gates: {},
    },
    session: { live: true },
    health: { ok: true, warnings: [], memoryHealth: { score: 80, dimensions: {}, suggestions: [] } },
  };
  const normalized = internals.normalizeStatus(raw);
  if (!('pendingWrites' in normalized)) {
    t.skip('[waiting] normalizeStatus does not carry pendingWrites/readiness/session yet (v9 ui-commands)');
    return;
  }
  assert.equal(normalized.pendingWrites.count, 1);
  assert.equal(normalized.pendingWrites.items[0].candidate.name, 'queued note');
  assert.equal(normalized.readiness.eligible, false);
  assert.equal(normalized.readiness.nextEligibleAt, 123);
  assert.equal(normalized.readiness.reasons[0].code, 'min-hours');
  assert.equal(normalized.session.live, true);
  assert.equal(normalized.health.memoryHealth.score, 80);
});

// ---------------------------------------------------------------------------
// v10 P1: dream history/undo, edit/merge/history, search, trend, import/export
// ---------------------------------------------------------------------------

test('client: normalizeStatus carries the v10 status blocks when present', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const normalized = internals.normalizeStatus({
    ok: true,
    config: {},
    index: { text: '', lines: 0, bytes: 0 },
    entries: [],
    userScope: { enabled: false, entries: [] },
    state: {},
    metrics: {},
    dreamHistory: { items: [{ ts: '2026-11-07T00-00-00', kind: 'apply', undoable: true, hasMeta: true }] },
    subagentPolicy: { injectSubagents: true, mode: 'shared' },
    search: { query: '', items: [] },
  });
  if (!('dreamHistory' in normalized)) {
    t.skip('[waiting] normalizeStatus does not carry dreamHistory/subagentPolicy yet (v10 ui-commands)');
    return;
  }
  assert.equal(normalized.dreamHistory.items.length, 1);
  assert.equal(normalized.dreamHistory.items[0].undoable, true);
  assert.equal(normalized.subagentPolicy.mode, 'shared');
});

// ---------------------------------------------------------------------------
// v4 UI (three tabs): pure helpers and locale coverage
// ---------------------------------------------------------------------------

function v4Internals(client) {
  const internals = client.windowObject.__CC_MEMORY_INTERNALS__;
  for (const name of ['filterEntries', 'countByType', 'opKind', 'projectLabel', 'attentionCount', 'viaLabel', 'readinessText']) {
    assert.equal(typeof internals[name], 'function', `__CC_MEMORY_INTERNALS__.${name} must be a function`);
  }
  return internals;
}

const v4Entries = [
  { file: 'user_lang.md', name: 'Reply language', description: 'answer in Chinese', type: 'user', modified: '2026-11-01T00:00:00Z' },
  { file: 'feedback_tests.md', name: 'Real database', description: 'no mocks in integration tests', type: 'feedback', modified: '2026-11-05T00:00:00Z' },
  { file: 'project_freeze.md', name: 'Release freeze', description: 'only fixes after Nov 20', type: 'project', modified: '2026-11-03T00:00:00Z' },
];

test('client v4: filterEntries sorts by recency, filters by type and merges server body hits', async () => {
  const internals = v4Internals(await loadClient());
  const all = internals.filterEntries(v4Entries, {});
  // Results come from the vm realm: copy them into this realm before deepEqual.
  const files = (list) => Array.from(list, (entry) => entry.file);
  assert.deepEqual(files(all), ['feedback_tests.md', 'project_freeze.md', 'user_lang.md'], 'newest first');

  const typed = internals.filterEntries(v4Entries, { type: 'project' });
  assert.deepEqual(files(typed), ['project_freeze.md']);

  const local = internals.filterEntries(v4Entries, { query: 'release' });
  assert.deepEqual(files(local), ['project_freeze.md'], 'name/description match locally');

  const hits = new Map([['user_lang.md', { score: 3 }]]);
  const merged = internals.filterEntries(v4Entries, { query: 'zhongwen', hits });
  assert.deepEqual(files(merged), ['user_lang.md'], 'a server body hit is kept even without a local match');

  const ranked = internals.filterEntries(v4Entries, { query: 'real', hits: new Map([['project_freeze.md', { score: 1 }]]) });
  assert.equal(ranked[0].file, 'feedback_tests.md', 'a name match ranks above a body-only hit');
});

test('client v4: counts, op kinds, project label and attention count', async () => {
  const internals = v4Internals(await loadClient());
  assert.deepEqual({ ...internals.countByType(v4Entries) }, { all: 3, user: 1, feedback: 1, project: 1, reference: 0 });

  assert.equal(internals.opKind({ op: 'write', before: '', after: 'x' }), 'create');
  assert.equal(internals.opKind({ op: 'write', before: 'a', after: 'b' }), 'update');
  assert.equal(internals.opKind({ op: 'delete', before: 'a', after: '' }), 'delete');
  assert.equal(internals.opKind({ op: 'index', before: 'a', after: 'b' }), 'index');

  const backslash = String.fromCharCode(92);
  assert.equal(internals.projectLabel({ projectRoot: ['C:', 'Users', 'me', 'repo'].join(backslash) }), 'repo');
  assert.equal(internals.projectLabel({ projectRoot: '/home/me/app/' }), 'app');
  assert.equal(internals.projectLabel({ projectId: 'rent-calculator' }), 'rent-calculator');

  const status = internals.normalizeStatus({
    pendingWrites: { count: 2, items: [] },
    state: { lastPlanPath: '/x/plan.json' },
  });
  assert.equal(internals.attentionCount(status), 3, 'two queued writes plus one plan waiting for review');
  assert.equal(internals.attentionCount(internals.normalizeStatus({})), 0);
});

test('client v4: provenance and readiness codes become friendly sentences', async () => {
  const internals = v4Internals(await loadClient());
  const t = (key, params) => (params ? key + JSON.stringify(params) : key);
  assert.equal(internals.viaLabel('tool:memory_save', t), 'via.agent');
  assert.equal(internals.viaLabel('command:/remember', t), 'via.command');
  assert.equal(internals.viaLabel('dream', t), 'via.tidy');
  assert.equal(internals.viaLabel('api:edit', t), 'via.you');
  assert.equal(internals.viaLabel('', t), '');

  const config = { minHours: 24, minSessions: 5 };
  const ready = internals.normalizeReadiness({ eligible: true, reasons: [], gates: {} });
  assert.equal(internals.readinessText(ready, config, t), 'tidy.ready');
  const waiting = internals.normalizeReadiness({
    eligible: false,
    reasons: [{ code: 'auto-dream-off' }, { code: 'min-sessions', message: 'only 2 of 5' }],
    gates: { minSessions: { ok: false, current: 2, required: 5 } },
  });
  assert.equal(internals.readinessText(waiting, config, t), 'readiness.min-sessions{"current":2,"required":5}');
});

test('client v4: every literal t() key used by client.js exists in both dictionaries', async () => {
  const client = await loadClient();
  const { dictionaries } = await mountClient(client);
  const [{ dicts }] = dictionaries;
  const source = await clientSource();
  const keys = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_.-]+)'\s*[,)]/g)].map((match) => match[1]));
  assert.ok(keys.size > 60, `expected many literal keys, found ${keys.size}`);
  // Keys built at runtime from a fixed set of values.
  for (const type of ['all', 'user', 'feedback', 'project', 'reference']) keys.add('type.' + type);
  for (const type of ['user', 'feedback', 'project', 'reference']) keys.add('edit.typeHint.' + type);
  for (const kind of ['create', 'update', 'delete', 'index']) keys.add('tidy.op.' + kind);
  for (const source of ['default', 'project', 'global']) keys.add('rules.source.' + source);
  for (const scope of ['project', 'user']) keys.add('scope.' + scope);
  for (const key of keys) {
    assert.equal(typeof dicts.en[key], 'string', `en dictionary is missing ${key}`);
    assert.equal(typeof dicts.zh[key], 'string', `zh dictionary is missing ${key}`);
  }
});
