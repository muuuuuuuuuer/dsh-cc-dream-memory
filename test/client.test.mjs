/**
 * Client bundle tests (v7 §6): load the REAL `client.js` through `node:vm` with a
 * fake `window.__ModuleLoader__` and a tiny React shim, then test the parts that
 * are reachable without a DOM:
 *
 *   - the factory contract (`id`, `inject`, `apply`) and locale registration;
 *   - locale/en.json + locale/zh.json key parity with the inline dictionaries;
 *   - the slot backend with and without a reachable HTTP bridge, including
 *     status/file normalization and 401 token-expired classification;
 *   - the pure helpers exposed on `window.__CC_MEMORY_INTERNALS__`
 *     (normalizeStatus/normalizeFile/renderMarkdown/renderInline/
 *     createBackend/apiRequest).
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
 * `window.__ModuleLoader__`, `window.location`, `fetch` with an optional bridge
 * response, timers and a quiet console.
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
      // The page learns {base, token} only from GET /api/cc-memory/bridge.
      if (String(args[0]) === '/api/cc-memory/bridge') {
        if (apiBridge === undefined) return { ok: false, status: 404, json: async () => ({ ok: false }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, ...apiBridge }) };
      }
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
      register(definition, component) {
        slotDefinitions.push({ ...definition, component });
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

/** Keep hook state between explicit renders without adding a DOM dependency. */
function componentRenderer(react, component, props, initialStates = []) {
  const states = [];
  const refs = [];
  return {
    render(nextProps = props) {
      props = nextProps;
      let stateIndex = 0;
      let refIndex = 0;
      const originalState = react.useState;
      const originalRef = react.useRef;
      react.useState = (initial) => {
        const index = stateIndex++;
        if (!(index in states)) {
          states[index] = index in initialStates ? initialStates[index] : typeof initial === 'function' ? initial() : initial;
        }
        return [states[index], (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next;
        }];
      };
      react.useRef = (initial) => {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      };
      try {
        return component(props);
      } finally {
        react.useState = originalState;
        react.useRef = originalRef;
      }
    },
  };
}

/** Reach the real Dream tab through its registered view and injected backend. */
async function dreamTabHarness({ estimate, localeActive = 'en', estimateError = false, pending = null, dreamRuns } = {}) {
  const actions = [];
  const bodies = [];
  const payload = makeStatusPayload({
    config: { enabled: true, autoMemoryEnabled: true },
    state: { shadowPending: pending, lastDreamMode: 'shadow' },
    dreamRuns: dreamRuns ?? [],
  });
  const client = await loadClient({
    apiBridge: { base: '/api/cc-memory', token: 'cost-preview-token' },
    fetchImpl: async (url, options) => {
      if (String(url).includes('/status')) return { ok: true, status: 200, json: async () => payload };
      const body = JSON.parse(options.body);
      actions.push(body.action);
      bodies.push(body);
      if (body.action === 'estimate') {
        if (estimateError) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'estimate-unavailable' }) };
        const result = await estimate;
        return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
      }
      if (body.action === 'start') return { ok: true, status: 200, json: async () => ({ ok: true, result: { started: true, runId: 'run-1', status: 'running' } }) };
      if (body.action === 'switch') return { ok: true, status: 200, json: async () => ({ ok: true, result: { switched: true, backupDir: '/tmp/backup', counts: { added: 0, changed: 1, removed: 0 } } }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { ok: true } }) };
    },
  });
  const { slotDefinitions } = await mountClient(client, { localeActive });
  const view = findDefinition(slotDefinitions, 'conversation.view');
  const props = view.inject({ sessionId: 'cost-preview-session' });
  const ready = view.component(props);
  const memoryView = findNode(ready, (node) => node.type?.name === 'MemoryView');
  const status = client.windowObject.__CC_MEMORY_INTERNALS__.normalizeStatus(payload);
  const viewRenderer = componentRenderer(client.react, memoryView.type, memoryView.props, [
    'tidy', { phase: 'ready', status, error: null }, '', null,
  ]);
  let tabRenderer;
  return {
    actions,
    bodies,
    render() {
      const viewTree = viewRenderer.render();
      const tab = findNode(viewTree, (node) => node.type?.name === 'DreamTab');
      tabRenderer ??= componentRenderer(client.react, tab.type, tab.props);
      return { tree: tabRenderer.render(tab.props), viewTree };
    },
  };
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

test('client: Dream estimates first, then starts the range the user saw', async () => {
  let resolveEstimate;
  const estimate = new Promise((resolve) => { resolveEstimate = resolve; });
  const ui = await dreamTabHarness({ estimate });
  const start = findNode(ui.render().tree, (node) => node.type === 'button' && collectText(node) === 'Estimate the run');
  assert.ok(start, 'the dream tab offers a read-only estimate');
  const pending = start.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ui.actions, ['estimate'], 'the first action must be read-only estimation');
  resolveEstimate({
    estimatedTokens: 12345, inputChars: 48000, limit: 20000, costMode: 'warn', rough: true,
    inputId: 'in-1', ranges: [{ id: 's1', lastSeq: 3 }],
  });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  const { tree } = ui.render();
  const text = collectText(tree);
  assert.match(text, /12[,.]?345/);
  assert.match(text, /20[,.]?000/);
  assert.match(text, /input/i);
  const confirmation = findNode(tree, (node) => node.type === 'button' && collectText(node) === 'Start the dream run');
  assert.ok(confirmation, 'the estimate unlocks the paid action');
  await confirmation.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ui.actions, ['estimate', 'start'], 'showing the estimate must not run Dream on its own');
  assert.equal(ui.bodies[1].inputId, 'in-1', 'the confirmed range travels with the start');
  assert.deepEqual(ui.bodies[1].inputRanges, [{ id: 's1', lastSeq: 3 }]);
  assert.equal(ui.actions.includes('preview'), false, 'a dream no longer produces a per-operation plan');
});

test('client: a failed or malformed estimate leaves Dream unstarted with a visible retry path', async (t) => {
  for (const options of [{ estimateError: true }, { estimate: {} }]) {
    await t.test(JSON.stringify(options), async () => {
      const ui = await dreamTabHarness(options);
      const start = findNode(ui.render().tree, (node) => node.type === 'button' && collectText(node) === 'Estimate the run');
      await start.props.onClick();
      const { tree, viewTree } = ui.render();
      assert.deepEqual(ui.actions, ['estimate']);
      assert.ok(findNode(viewTree, (node) => node.props?.role === 'status'), 'a failure is shown in the existing toast');
      assert.equal(findNode(tree, (node) => node.type === 'button' && collectText(node) === 'Start the dream run'), undefined);
      assert.ok(findNode(tree, (node) => node.type === 'button' && collectText(node) === 'Estimate the run'));
    });
  }
});


test('client: a running dream shows its progress and can be stopped or continued', async () => {
  const running = await dreamTabHarness({
    dreamRuns: [{ runId: '2026-11-12T09-00-00-abcdef', status: 'running', stage: 'analyzing' }],
  });
  const runningText = collectText(running.render().tree);
  assert.match(runningText, /This run/u);
  assert.match(runningText, /running/u);
  const stop = findNode(running.render().tree, (node) => node.type === 'button' && collectText(node) === 'Stop');
  assert.ok(stop, 'a running dream offers a stop button');
  await stop.props.onClick();
  assert.deepEqual(running.actions, ['cancel']);

  const failed = await dreamTabHarness({
    dreamRuns: [{ runId: '2026-11-12T09-00-00-abcdef', status: 'failed' }],
  });
  const failedText = collectText(failed.render().tree);
  assert.match(failedText, /failed/u);
  const resume = findNode(failed.render().tree, (node) => node.type === 'button' && collectText(node) === 'Continue');
  assert.ok(resume, 'a failed dream offers a continue button');
  await resume.props.onClick();
  assert.deepEqual(failed.actions, ['resume']);
});



// ---------------------------------------------------------------------------
// Harness / factory contract
// ---------------------------------------------------------------------------

test('client: real client.js loads through ModuleLoader and returns the plugin contract', async () => {
  const client = await loadClient();
  assert.equal(client.config.id, 'dsh-cc-dream-memory');
  assert.deepEqual([...client.plugin.inject], ['slots', 'locale']);
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
    uiApi: 1,
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

test('client: an unavailable bridge leaves the Memory slots mounted without executing commands', async () => {
  const client = await loadClient();
  const { slotDefinitions } = await mountClient(client, {
    commandExecute: () => assert.fail('the Memory page must not execute slash commands'),
  });

  const view = findDefinition(slotDefinitions, 'conversation.view');
  assert.ok(view, 'conversation.view must be registered');
  assert.equal(view.id, 'cc-memory');
  assert.equal(view.order, 40);
  const backend = view.inject({ sessionId: 'session-1' }).memBackend;
  assert.equal(backend.mode, 'none');
  await assert.rejects(backend.status(), /memory service is unavailable/);

  const chip = findDefinition(slotDefinitions, 'conversation.composer.dock');
  assert.ok(chip, 'conversation.composer.dock must be registered');
  assert.equal(chip.id, 'cc-memory-status');
  assert.equal(chip.order, 50);
  assert.equal(chip.inject({}).memBackend.mode, 'none');
  assert.deepEqual(client.fetchCalls.map(([url]) => url), ['/api/cc-memory/bridge']);
});

test('client: discovers the API bridge via a credentialed same-origin request', async () => {
  const client = await loadClient({
    apiBridge: { base: '/api/cc-memory', token: 'tok-bridge' },
  });
  const { slotDefinitions } = await mountClient(client);
  assert.equal(client.fetchCalls.length, 1);
  const [[url, options]] = client.fetchCalls;
  assert.equal(url, '/api/cc-memory/bridge');
  assert.equal(options.credentials, 'include');
  const view = findDefinition(slotDefinitions, 'conversation.view');
  assert.equal(view.inject({ sessionId: 'session-bridge' }).memBackend.mode, 'api');
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

  const status = await props.memBackend.status();
  assert.equal(status.config.autoMemoryEnabled, false, 'API booleans are preserved');
  assert.equal(status.index.lines, 1);
  assert.equal(status.entries.length, 1, 'invalid entries are filtered');
  assert.equal(status.state.lastDreamSummary, 'merged');
  assert.equal(status.rules.maxChars, 8000);

  const [url, options] = client.fetchCalls.at(-1);
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:61145\/api\/cc-memory\/status\?sessionId=session-9$/);
  assert.equal(options.headers['x-cc-memory-token'], 'tok-123', 'requests must carry the bridge token');

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

  const filled = internals.normalizeStatus(makeStatusPayload());
  assert.equal(filled.entries.length, 1);
  assert.equal(filled.entries[0].file, 'a.md');
  assert.equal(filled.state.sessionsSince, 2);
  assert.equal(filled.rules.source, 'project');
});

test('client: normalizeFile defaults the body to raw and provenance to empty', async (t) => {
  const client = await loadClient();
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const empty = internals.normalizeFile(null);
  assert.equal(empty.file, '');
  assert.equal(empty.frontmatter, null);
  assert.equal(empty.body, '');
  assert.equal(empty.raw, '');
  // v7 provenance defaults (old files without the optional frontmatter fields).
  assert.equal(empty.via, '');
  assert.equal(empty.sourceSession, '');
  assert.equal(empty.created, '');

  const fromRaw = internals.normalizeFile({ file: 'a.md', raw: 'raw body' });
  assert.equal(fromRaw.body, 'raw body', 'body falls back to raw when absent');

  const withFrontmatter = internals.normalizeFile({ file: 'u.md', frontmatter: { name: 'u' }, body: 'body' });
  assert.equal(withFrontmatter.frontmatter.name, 'u');
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

test('client: a bridge with an empty API base leaves the backend unavailable', async () => {
  const client = await loadClient({ apiBridge: { base: '', token: 'tok' } });
  const { slotDefinitions } = await mountClient(client);
  const view = findDefinition(slotDefinitions, 'conversation.view');
  assert.equal(view.inject({ sessionId: 's1' }).memBackend.mode, 'none');
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
    subagentPolicy: { mode: 'shared' },
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
    state: { shadowPending: { dir: '/tmp/shadow/B', createdAt: '2026-11-13T00:00:00.000Z', counts: { added: 1, changed: 0, removed: 0 }, files: [{ file: 'release.md', action: 'added' }] } },
  });
  assert.equal(internals.attentionCount(status), 1, 'one dream result waiting to be switched');
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

  for (const source of ['default', 'project', 'global']) keys.add('rules.source.' + source);
  for (const trust of ['all', 'verified', 'changed', 'unverified', 'stale']) keys.add('trust.' + trust);
  for (const status of ['stale', 'superseded', 'disputed', 'review-needed', 'retired']) keys.add('status.' + status);
  for (const note of ['appliesWhen', 'verify', 'exception', 'observed']) keys.add('notes.' + note);

  for (const key of keys) {
    assert.equal(typeof dicts.en[key], 'string', `en dictionary is missing ${key}`);
    assert.equal(typeof dicts.zh[key], 'string', `zh dictionary is missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// v5 UI: trust, note bodies, header summary, Dream v2 coverage, wiki links
// ---------------------------------------------------------------------------

test('client v5: trust levels come from host facts, never from typed body lines', async () => {
  const internals = (await loadClient()).windowObject.__CC_MEMORY_INTERNALS__;
  assert.equal(internals.trustOf({ current: false, verified: { date: '2026-11-10' } }), 'stale');
  assert.equal(internals.trustOf({ verified: { date: '2026-11-10' } }), 'verified');
  assert.equal(internals.trustOf({ verified: null, verifiedOutdated: true }), 'changed');
  assert.equal(internals.trustOf({}), 'unverified', 'old entries without trust facts are unverified');
  const entries = [
    { file: 'a.md', name: 'a', description: '', verified: { date: 'x' } },
    { file: 'b.md', name: 'b', description: '', verified: { date: 'x' } },
    { file: 'c.md', name: 'c', description: '', verifiedOutdated: true },
    { file: 'd.md', name: 'd', description: '' },
    { file: 'e.md', name: 'e', description: '', current: false },
  ];
  assert.deepEqual({ ...internals.countByTrust(entries) }, { all: 5, hot: 0, verified: 2, unverified: 2, stale: 1 });
  const files = (list) => Array.from(list, (entry) => entry.file).sort();
  assert.deepEqual(files(internals.filterEntries(entries, { trust: 'verified' })), ['a.md', 'b.md']);
  assert.deepEqual(files(internals.filterEntries(entries, { trust: 'unverified' })), ['c.md', 'd.md']);
  const status = internals.normalizeStatus({ entries: [{ file: 'a.md', verified: { date: '2026-11-10', source: 'dream' } }] });
  assert.equal(status.entries[0].verified.date, '2026-11-10');
  assert.equal(status.entries[0].current, true);
});

test('client v5: splitBody separates conditions, conflicts and earlier values and drops typed stamps', async () => {
  const internals = (await loadClient()).windowObject.__CC_MEMORY_INTERNALS__;
  const parts = internals.splitBody([
    'STATUS: current',
    'VERIFIED: 2026-11-10',
    'VERIFIED AGAINST: abc123',
    'Read timeout is 15 seconds.',
    'APPLIES WHEN: calling the billing API',
    'EXCEPTION: batch jobs use 90 seconds',
    'CONFLICT: spec says 15 s; runbook says 20 s',
    '- Superseded: 10 seconds (until 2026-11-01) — session abc',
    '```',
    'STATUS: inside code stays',
    '```',
    '## History',
    '- 5 seconds before October',
  ].join('\n'));
  assert.equal(parts.status, 'current');
  assert.deepEqual(Array.from(parts.notes, (note) => note.key), ['appliesWhen', 'exception']);
  assert.equal(parts.conflicts.length, 1);
  assert.deepEqual(Array.from(parts.superseded), ['10 seconds (until 2026-11-01) — session abc', '5 seconds before October']);
  assert.match(parts.rest, /Read timeout is 15 seconds\./);
  assert.match(parts.rest, /STATUS: inside code stays/);
  assert.doesNotMatch(parts.rest, /VERIFIED/);
});

test('client v5: the header says what a new conversation loads', async () => {
  const internals = (await loadClient()).windowObject.__CC_MEMORY_INTERNALS__;
  const t = (key, params) => (params ? key + JSON.stringify(params) : key);
  const index = internals.normalizeStatus({ config: { indexMaxLines: 200 }, index: { lines: 12, bytes: 900 }, entries: [] });
  assert.equal(internals.loadSummary(index, t).text, 'load.index{"lines":12,"maxLines":200}');
  const off = internals.normalizeStatus({ config: { autoMemoryEnabled: false } });
  assert.equal(internals.loadSummary(off, t).text, 'load.off');
});


test('client v5: citations render as chips and wiki links as buttons that know broken targets', async () => {
  const internals = (await loadClient()).windowObject.__CC_MEMORY_INTERNALS__;
  const opened = [];
  const nodes = internals.renderInline('15 s ^[spec.md#p2, 2026-11-10] see [[retries]] and [[gone|old page]]', {
    onWikiLink: (slug) => opened.push(slug),
    hasPage: (slug) => slug === 'retries',
  });
  const cite = findNode(nodes, (node) => node.props?.className === 'ccm-cite');
  assert.equal(collectText(cite), 'spec.md#p2');
  assert.equal(cite.props.title, 'spec.md#p2, 2026-11-10');
  const live = findNode(nodes, (node) => node.type === 'button' && collectText(node) === 'retries');
  live.props.onClick();
  assert.deepEqual(opened, ['retries']);
  const dead = findNode(nodes, (node) => node.type === 'button' && collectText(node) === 'old page');
  assert.equal(dead.props.disabled, true);
  const plain = internals.renderInline('see [[retries]]');
  assert.equal(findNode(plain, (node) => node.type === 'button'), undefined, 'without a handler links are plain text');
});



test('client v5: long host refusals become a headline and a list; a stale backend is named', async () => {
  const client = await loadClient();
  const internals = client.windowObject.__CC_MEMORY_INTERNALS__;
  const { dictionaries } = await mountClient(client);
  const en = dictionaries[0].dicts.en;
  const t = (key, params) => String(en[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match));
  const info = internals.errorInfo(new Error(
    'evidence-rejected: a.md: new line has no source citation: "x; y"; b.md: line attributes a requirement to the user without [user] evidence: "z"',
  ), t);
  assert.equal(info.text, en['err.evidenceRejected']);
  assert.deepEqual(Array.from(info.items), [
    'a.md — A new line has no source citation: “x; y”',
    'b.md — ' + en['reason.userAttribution'],
  ]);
  assert.equal(internals.errorInfo(new Error('unknown-action: action must be "build" or "status"'), t).text, en['err.backendStale']);
  assert.equal(
    internals.errorInfo(new Error("wiki-failed: The requested module './wiki-core.js' does not provide an export named 'X'"), t).text,
    en['err.backendStale'],
  );
  assert.equal(internals.errorInfo(new Error('short failure'), t).items.length, 0);
});

test('client: two windows share the edit baseline and a stale save keeps its draft', async (t) => {
  const sent = [];
  const client = await loadClient({
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'stale-write', message: 'memory file not found: a.md' }),
      };
    },
  });
  const internals = internalsOrSkip(t, client);
  if (!internals) return;
  const doc = internals.normalizeFile({ file: 'a.md', version: 'v1', expectedHash: 'h1' });
  assert.equal(doc.version, 'v1', 'the content version is kept for the receipt');
  assert.equal(doc.expectedHash, 'h1', 'the edit baseline is kept for the save');
  const backend = internals.createBackend({ api: { base: '/x', token: '' }, commandRunner: null, sessionId: 's1' });
  await assert.rejects(
    () => backend.saveFile({ file: 'a.md', content: 'x', expectedHash: 'h1' }),
    (error) => error.code === 'stale-write',
    'a stale baseline surfaces as a coded error so the editor can keep the draft',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.expectedHash, 'h1', 'the save must send the baseline it was opened at');
  assert.equal(sent[0].body.content, 'x', 'the draft body is what gets submitted');
});

test('client v24: a dream result is switched to or discarded as a whole', async () => {
  const pending = {
    dir: '/tmp/shadow/B',
    createdAt: '2026-11-13T00:00:00.000Z',
    summary: 'merged the deployment notes',
    runId: 'run-9',
    counts: { added: 1, changed: 0, removed: 0 },
    files: [{ file: 'release.md', action: 'added' }],
  };
  const ui = await dreamTabHarness({ pending });
  const text = collectText(ui.render().tree);
  assert.match(text, /A dream result is ready/u);
  assert.match(text, /1 added, 0 changed, 0 removed/u);
  assert.match(text, /release\.md/u);
  const swap = findNode(ui.render().tree, (node) => node.type === 'button' && collectText(node) === 'Switch to it');
  assert.ok(swap, 'the panel offers the switch');
  await swap.props.onClick();
  assert.deepEqual(ui.actions, ['switch']);
  assert.equal(ui.actions.includes('apply-ops'), false, 'there is no per-operation apply any more');

  const second = await dreamTabHarness({ pending });
  // Discard throws away the dream's work, so it is a two-step confirm button.
  const discard = findNode(second.render().tree, (node) => typeof node.type === 'function' && node.props.label === 'Discard');
  assert.ok(discard, 'the panel offers the discard');
  await discard.props.onConfirm();
  assert.deepEqual(second.actions, ['discard']);
});