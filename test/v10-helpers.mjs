/**
 * Shared fixtures for the v10 P1 test files (undo/edit/search/metrics/
 * import-export/lock/subagent/digest).
 *
 * All fixtures are real modules over os.tmpdir(); `modules()` is a superset
 * loader so every v10 test can share it. The v10-only modules (`src/lock.js`,
 * `src/import-export.js`) are loaded lazily so a test that does not need them
 * keeps working while they land.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { loadModule, makeTempDir } from './helpers.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('condition was not satisfied within the timeout');
}

export function streamOf(chunks) {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

let modulesPromise;

/** Superset loader for the modules most v10 tests touch. */
export function modules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      config: await loadModule('../src/config.js', { requireExports: ['resolveConfig'] }),
      paths: await loadModule('../src/paths.js', { requireExports: ['buildPaths'] }),
      store: await loadModule('../src/store.js', { requireExports: ['MemoryStore'] }),
      state: await loadModule('../src/state.js', { requireExports: ['ProjectState'] }),
      runtime: await loadModule('../src/runtime.js', { requireExports: ['MemoryRuntime'] }),
      meta: await loadModule('../src/meta.js', { requireExports: ['VERSION'] }),
      metrics: await loadModule('../src/metrics.js', {
        requireExports: ['readMetrics', 'recordInjection', 'recordRead', 'recordWrite', 'recordSearch', 'recordDream', 'metricsSummary'],
      }),
      status: await loadModule('../src/status.js', { requireExports: ['createStatusService'] }),
      http: await loadModule('../src/http.js', { requireExports: ['createHttpHandler', 'API_PREFIX'] }),
      tools: await loadModule('../src/tools.js', { requireExports: ['registerTools'] }),
      commands: await loadModule('../src/commands.js', { requireExports: ['registerCommands'] }),
      inject: await loadModule('../src/inject.js', { requireExports: ['registerInjection'] }),
      policy: await loadModule('../src/policy.js', {
        requireExports: ['POLICY_DEFAULTS', 'textSimilarity', 'entrySimilarity', 'detectConflict', 'evaluateWrite'],
      }),
    }))();
  }
  return modulesPromise;
}

/** v10 module loaded lazily (may not exist yet when other tests run). */
export async function lockModule() {
  return loadModule('../src/lock.js', { requireExports: ['withFileLock'] });
}

export async function importExportModule() {
  return loadModule('../src/import-export.js', {
    requireExports: ['importClaudeMemory', 'exportClaudeMemory'],
  });
}

/** Fake Cordis plugin context (optional services + event bus + llm mock). */
export function fakeHost({ workspaceDir, plan = null, usage = null } = {}) {
  const listeners = new Map();
  const llmCalls = [];
  const services = {
    workingDirectory: { ensure: async () => workspaceDir },
    llm: {
      stream() {
        llmCalls.push(true);
        const text =
          typeof plan === 'string'
            ? plan
            : JSON.stringify(plan ?? { summary: 'v10 plan', operations: [] });
        const chunks = [{ type: 'text-delta', text }];
        if (usage) chunks.push({ type: 'usage', usage });
        chunks.push({ type: 'finish', reason: { kind: 'stop' } });
        return streamOf(chunks);
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    sessionQuery: { filterSessions: async () => [], readSession: async () => undefined },
  };
  return {
    services,
    llmCalls,
    get: (name) => services[name],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    effect(factory) {
      const dispose = factory();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
}

/**
 * Give the fake host a transcript with these user messages, so a write can carry
 * `basis: 'user-explicit'` and a verbatim `evidence` quote the host can verify.
 */
export function seedUserMessages(env, ...texts) {
  const events = texts.map((text, index) => ({
    type: 'user/message',
    seq: index + 1,
    time: Date.parse('2026-11-11T09:00:00Z') + index,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }));
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({ session: { id }, events }),
  };
  return env;
}

/**
 * Script one Dream for a runtime env: the transcripts the host returns and what
 * the analyzer answers. `sessions` maps a session id to the user's messages.
 * `claims`/`verify` are the analyzer reply for every unit, or pass
 * `analyzer(prompt)` to answer per unit. Only analyzer calls are expected: Dream
 * has no other model stage. Returns the list of analyzer prompts sent.
 */
export async function scriptDream(env, {
  sessions = { s1: ['Deploy with make release.'] },
  claims = [],
  verify = [],
  summary = 'scripted dream',
  usage = null,
  analyzer = null,
} = {}) {
  const { ANALYZER_SYSTEM_PROMPT } = await import('../src/dream-analyzer.js');
  const prompts = [];
  const eventsById = new Map(Object.entries(sessions).map(([id, texts]) => [id, texts.map((message, index) => ({
    type: 'user/message',
    seq: index + 1,
    time: Date.parse('2026-11-12T09:00:00Z') + index,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: message }] },
  }))]));
  env.host.services.sessionQuery = {
    filterSessions: async () => [],
    readSession: async (id) => ({ session: { id, createdAt: '2026-11-12T09:00:00Z' }, events: eventsById.get(id) ?? [] }),
  };
  env.host.services.llm = {
    stream(options) {
      env.host.llmCalls.push(options);
      if (options?.system !== ANALYZER_SYSTEM_PROMPT) throw new Error('Dream should only call the analyzer');
      const prompt = (options.messages ?? []).flatMap((message) => message.content ?? []).map((part) => part.text ?? '').join('');
      prompts.push(prompt);
      const reply = typeof analyzer === 'function' ? analyzer(prompt) : { summary, claims, patches: [], verify };
      const chunks = [{ type: 'text-delta', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }];
      if (usage) chunks.push({ type: 'usage', usage });
      chunks.push({ type: 'finish', reason: { kind: 'stop' } });
      return streamOf(chunks);
    },
  };
  for (const id of Object.keys(sessions)) await env.pctx.state.ensureSession(id);
  return prompts;
}

/** One analyzer claim quoting a user message verbatim. */
export function claimOf(textValue, { target = '', quote = textValue, kind = 'project', confidence = 'high' } = {}) {
  return { text: textValue, quote, kind, confidence, ...(target ? { target } : {}) };
}

export async function exists(file) {
  try {
    const { access } = await import('node:fs/promises');
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Temp project with real store/state but no runtime. */
export async function makeEnv(t, configOverrides = {}) {
  const mods = await modules();
  const tmp = await makeTempDir(t);
  const memoryRoot = path.join(tmp, 'memory-root');
  const workspaceDir = path.join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const config = mods.config.resolveConfig({ memoryRoot, ...configOverrides });
  const paths = mods.paths.buildPaths({ memoryRoot: config.memoryRoot, homeDir: path.join(tmp, 'home'), workspaceDir });
  const store = new mods.store.MemoryStore({ paths, getConfig: () => config });
  await store.ensure();
  const state = new mods.state.ProjectState(paths);
  await state.load();
  const pctx = { workspaceDir, paths, store, state };
  return { mods, tmp, memoryRoot, workspaceDir, config, paths, store, state, pctx };
}

/** Temp project with a real MemoryRuntime + fake host (and optional llm plan). */
export async function runtimeEnv(t, configOverrides = {}, llmOptions = {}) {
  const env = await makeEnv(t, configOverrides);
  const host = fakeHost({ workspaceDir: env.workspaceDir, ...llmOptions });
  const runtime = new env.mods.runtime.MemoryRuntime(host, env.config);
  const pctx = await runtime.storeFor(env.workspaceDir);
  return { ...env, host, runtime, pctx };
}

/** runtimeEnv + registered memory tools (definition map). */
export async function toolsEnv(t, configOverrides = {}, llmOptions = {}) {
  const env = await runtimeEnv(t, configOverrides, llmOptions);
  const definitions = new Map();
  env.host.services.tools = {
    register(definition) {
      definitions.set(definition.name, definition);
      return () => {};
    },
  };
  const dispose = env.mods.tools.registerTools(env.host, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  return { ...env, definitions };
}

/** runtimeEnv + registered slash commands (invoke helper for /memory). */
export async function commandEnv(t, configOverrides = {}, llmOptions = {}) {
  const env = await toolsEnv(t, configOverrides, llmOptions);
  const commandDefinitions = new Map();
  const commandCtx = {
    commands: {
      register(definition) {
        commandDefinitions.set(definition.name, definition);
        return () => commandDefinitions.delete(definition.name);
      },
    },
    get: (name) => (name === 'commands' ? commandCtx.commands : undefined),
    on: () => () => {},
    effect: (factory) => (typeof factory === 'function' ? factory() : undefined),
  };
  const dispose = env.mods.commands.registerCommands(commandCtx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });
  const memory = commandDefinitions.get('memory');
  if (!memory) throw new Error('/memory command was not registered');
  const invokeMemory = (rawInput, agent = { id: 'agent-1' }) =>
    memory.handler({ rawInput, agent, sessionId: agent.id ?? 'session-1' });
  return { ...env, commandDefinitions, invokeMemory };
}

/** HTTP handler over a runtime env with a fixed token. */
export async function httpEnv(t, configOverrides = {}, llmOptions = {}) {
  const env = await runtimeEnv(t, configOverrides, llmOptions);
  // The page always names its live session; register one so request routing
  // resolves it instead of treating the id as stale.
  await env.runtime.forAgent({ id: 's1' });
  const token = 'v10-test-token-abcdef';
  const handler = env.mods.http.createHttpHandler({ runtime: env.runtime, token });
  const handle = typeof handler === 'function' ? handler : handler.handle.bind(handler);
  return { ...env, token, handle };
}

export function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
      }
      return this;
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  };
  res.bodyText = () => Buffer.concat(chunks).toString('utf8');
  res.json = () => JSON.parse(res.bodyText() || 'null');
  return res;
}

/** Call the HTTP handler; routes are prefixed with the exported API_PREFIX. */
export async function callHttp(env, { method = 'GET', path: route = '/status', token, body, origin, remoteAddress } = {}) {
  const { http } = await modules();
  const headers = { host: '127.0.0.1:61784' };
  const authToken = token === undefined ? env.token : token;
  if (authToken !== undefined) headers['x-cc-memory-token'] = authToken;
  if (origin !== undefined) headers.origin = origin;
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = `${http.API_PREFIX}${route}`;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.socket = { remoteAddress: remoteAddress ?? '127.0.0.1', remotePort: 50000 };
  const res = fakeRes();
  await env.handle(req, res);
  return res;
}

/** Write one dream plan JSON and record it as the current plan. */
export async function writePlan(env, plan, { asPending = false } = {}) {
  const planPath = path.join(env.tmp, `plan-${Math.random().toString(36).slice(2, 10)}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  if (asPending) await env.pctx.state.setPendingProposal(planPath);
  else await env.pctx.state.setLastPlan(planPath, 'dry-run');
  return planPath;
}

/** A simple write plan applying one or more entries. */
export function writePlanOf(operations, extra = {}) {
  return { summary: extra.summary ?? 'v10 plan', operations, sessions: [], truncatedFiles: [], ...extra };
}

/** Minimal memory file text with frontmatter. */
export function memoryFile({ name, type = 'user', description = '', modified = new Date().toISOString(), created, via, sourceSession } = {}, body = 'body') {
  const lines = ['---', `name: ${name}`, `description: ${description}`, `type: ${type}`, `modified: ${modified}`];
  if (created) lines.push(`created: ${created}`);
  if (sourceSession) lines.push(`source_session: ${sourceSession}`);
  if (via) lines.push(`via: ${via}`);
  lines.push('---', '', body, '');
  return lines.join('\n');
}

/** Index lines for a set of topic files (standard format). */
export function indexFor(files) {
  return files.map((item) => `- [${item.name}](${item.file}) — ${item.description}`).join('\n') + '\n';
}
