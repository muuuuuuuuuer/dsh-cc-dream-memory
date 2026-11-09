/**
 * v11 step 4: desktop API bridge via the webserver `index-inject` event.
 * Contract `docs/superpowers/specs/2026-11-07-v11-user-six-steps.md` §4.
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runtimeEnv, exists } from './v10-helpers.mjs';
import { httpEnv, callHttp } from './v10-helpers.mjs';
import { loadModule, PLUGIN_ROOT } from './helpers.mjs';
import { readFile } from 'node:fs/promises';

const OWNER = { principal: { kind: 'owner' } };
const VIEWER = { principal: { kind: 'share-viewer' } };

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
  return {
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
    listenerCount(event) {
      return (listeners.get(event) ?? new Set()).size;
    },
  };
}

function sidePanelRows(ctx) {
  const rows = [];
  ctx.emit('webserver/index-inject', rows, OWNER);
  return rows;
}

function apiRow(rows) {
  return rows.find((row) => row && row.name === '__CC_MEMORY_API__');
}

test('v11 desktop: index-inject pushes the API global for owner peers only', async (t) => {
  const env = await runtimeEnv(t);
  const http = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });
  const ctx = fakeCtx({ workspaceDir: env.workspaceDir });
  const dispose = http.registerHttpApi(ctx, env.runtime);
  t.after(() => {
    if (typeof dispose === 'function') dispose();
  });

  assert.ok(ctx.listenerCount('webserver/index-inject') >= 1, 'a webserver/index-inject listener is registered');
  assert.ok(ctx.server.registerCalls >= 1, 'the HTTP handler is still registered on the web server');
  assert.equal(
    ctx.server.registerPath,
    '/api/cc-memory',
    'the prefix route must have no trailing slash (Host prefix matching would never match it)',
  );
  assert.equal(ctx.server.tapIndexCalls, 0, 'tapIndex is no longer used');

  const ownerRows = [];
  ctx.emit('webserver/index-inject', ownerRows, OWNER);
  const row = apiRow(ownerRows);
  assert.ok(row, `owner peers must receive the API row: ${JSON.stringify(ownerRows)}`);
  assert.equal(row.kind, 'global');
  assert.ok(row.value && typeof row.value === 'object');
  assert.equal(row.value.base, '/api/cc-memory');
  assert.equal(typeof row.value.token, 'string');
  assert.ok(row.value.token.length >= 16, 'the row carries the API token');

  const viewerRows = [];
  ctx.emit('webserver/index-inject', viewerRows, VIEWER);
  assert.equal(apiRow(viewerRows), undefined, 'non-owner (share-viewer) peers must not receive the token row');

  // Fail closed: an unknown/peer-less environment is treated like a non-owner
  // (a token must only be handed to a provably-owner browser peer).
  const peerlessRows = [];
  ctx.emit('webserver/index-inject', peerlessRows, undefined);
  assert.equal(apiRow(peerlessRows), undefined, 'a peer-less/legacy host must not receive the token row');
});

test('v11 desktop: the API row token matches the persisted API token', async (t) => {
  const env = await runtimeEnv(t);
  const http = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });
  const ctx = fakeCtx({ workspaceDir: env.workspaceDir });
  const dispose = http.registerHttpApi(ctx, env.runtime);
  t.after(() => dispose?.());

  const rows = [];
  ctx.emit('webserver/index-inject', rows, OWNER);
  const row = apiRow(rows);
  assert.ok(row);

  const tokenFile = path.join(path.dirname(env.runtime.overrideFile), '.api-token');
  assert.equal(await exists(tokenFile), true, 'the API token is persisted next to the override file');
  const persisted = (await readFile(tokenFile, 'utf8')).trim();
  assert.equal(row.value.token, persisted);
});

test('v11 desktop: no .api-tap.log diagnostic file is produced', async (t) => {
  const env = await runtimeEnv(t);
  const http = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });
  const ctx = fakeCtx({ workspaceDir: env.workspaceDir });
  const dispose = http.registerHttpApi(ctx, env.runtime);
  t.after(() => dispose?.());

  const rows = [];
  ctx.emit('webserver/index-inject', rows, OWNER);
  const dir = path.dirname(env.runtime.overrideFile);
  const names = await readdir(dir).catch(() => []);
  assert.equal(names.some((name) => name.includes('api-tap')), false, `no api-tap log: ${names.join(', ')}`);
});

test('v11 desktop: http.js no longer taps the index or writes the api-tap log', async () => {
  const source = await readFile(path.join(PLUGIN_ROOT, 'src', 'http.js'), 'utf8');
  assert.doesNotMatch(source, /\.tapIndex\s*\(/, 'tapIndex is no longer called');
  assert.doesNotMatch(source, /appendFileSync\([^)]*api-tap/, 'no api-tap log is written');
  assert.match(source, /webserver\/index-inject/, 'the bridge uses the index-inject event');
  assert.match(source, /__CC_MEMORY_API__/, 'the injected global name is present');
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
