/**
 * Desktop API bridge: the page gets {base, token} from `GET /api/cc-memory/bridge`.
 * Contract `docs/superpowers/specs/2026-11-07-v11-user-six-steps.md` §4.
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, exists } from './v10-helpers.mjs';
import { httpEnv, callHttp } from './v10-helpers.mjs';
import { injectNow, loadModule, PLUGIN_ROOT } from './helpers.mjs';
import { readFile } from 'node:fs/promises';

/** Fake plugin context with a webServer service and an event bus. */
function fakeCtx({ workspaceDir }) {
  const listeners = new Map();
  const server = {
    registerCalls: 0,
    registerPath: '',
    tapIndexCalls: 0,
    register(route) {
      this.registerCalls += 1;
      this.registerPath = route?.path ?? '';
      return () => {};
    },
    tapIndex(handler) {
      this.tapIndexCalls += 1;
      return () => {};
    },
  };
  const services = { workingDirectory: { ensure: async () => workspaceDir }, webServer: server };
  const ctx = {
    server,
    services,
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
  ctx.inject = injectNow(ctx);
  return ctx;
}

test('v11 desktop: the API route registers under the un-slashed prefix, without tapIndex', async (t) => {
  const env = await runtimeEnv(t);
  const http = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });
  const ctx = fakeCtx({ workspaceDir: env.workspaceDir });
  const dispose = http.registerHttpApi(ctx, env.runtime);
  t.after(() => dispose?.());
  assert.equal(ctx.server.registerCalls, 1, 'the HTTP handler is registered on the web server');
  assert.equal(
    ctx.server.registerPath,
    '/api/cc-memory',
    'the prefix route must have no trailing slash (Host prefix matching would never match it)',
  );
  assert.equal(ctx.server.tapIndexCalls, 0, 'tapIndex is not used');
});

test('v11 desktop: the API token is persisted next to the override file', async (t) => {
  const env = await runtimeEnv(t);
  const http = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });
  const ctx = fakeCtx({ workspaceDir: env.workspaceDir });
  const dispose = http.registerHttpApi(ctx, env.runtime);
  t.after(() => dispose?.());
  const tokenFile = path.join(path.dirname(env.runtime.overrideFile), '.api-token');
  assert.equal(await exists(tokenFile), true, 'the API token is persisted next to the override file');
  assert.ok((await readFile(tokenFile, 'utf8')).trim().length >= 16);
  const names = await readdir(path.dirname(env.runtime.overrideFile)).catch(() => []);
  assert.equal(names.some((name) => name.includes('api-tap')), false, `no api-tap log: ${names.join(', ')}`);
});

test('v11 desktop: http.js hands the token out only through /bridge', async () => {
  const source = await readFile(path.join(PLUGIN_ROOT, 'src', 'http.js'), 'utf8');
  assert.doesNotMatch(source, /\.tapIndex\s*\(/, 'tapIndex is not called');
  assert.doesNotMatch(source, /index-inject/, 'no index row carries the token');
  assert.match(source, /\/bridge/, 'the bridge route exists');
});

test('v12 desktop: /bridge returns the same base/token to a loopback GET (page-boot recovery)', async (t) => {
  const env = await httpEnv(t);
  const res = await callHttp(env, { path: '/bridge' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.base, '/api/cc-memory');
  assert.equal(body.token, env.token);
  assert.ok(body.token.length >= 16);
});

test('v12 desktop: /bridge is loopback-only and GET-only', async (t) => {
  const env = await httpEnv(t);
  const remote = await callHttp(env, { path: '/bridge', remoteAddress: '10.0.0.9' });
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.json().error, 'forbidden');

  const post = await callHttp(env, { method: 'POST', path: '/bridge', body: {} });
  assert.equal(post.statusCode, 405);
  assert.equal(post.json().error, 'method-not-allowed');
});

test('v12 desktop: the registered prefix actually matches the real Host prefix rule', () => {
  // Host webserver: match when `pathname === prefix || pathname.startsWith(prefix + '/')`.
  const matches = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  const registered = '/api/cc-memory';
  assert.equal(matches('/api/cc-memory/status', registered), true, 'status route matches');
  assert.equal(matches('/api/cc-memory/bridge', registered), true, 'bridge route matches');
  assert.equal(matches('/api/cc-memory/status', '/api/cc-memory/'), false, 'a trailing-slash prefix never matches');
});
